import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  getModelsCache,
  setModelsCache,
  isCacheValid,
  getCacheStatus,
  initializeCache,
} from '../catalog/cache.js';
import { getModels, getEndpoints, getParameters, hasApiKey } from '../openrouter/client.js';
import { task2model } from '../recommend/task2model.js';
import { TaskSpecSchema } from '../schema/taskSpec.js';
import type {
  SyncCatalogResult,
  ModelProfileResult,
} from '../schema/taskSpec.js';
import { isStructuredError, type StructuredError } from '../util/errors.js';
import { log } from '../util/logger.js';

// Create MCP server instance
const server = new McpServer(
  {
    name: 'openrouter-task2model',
    version: '1.4.1',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool: sync_catalog
server.registerTool(
  'sync_catalog',
  {
    description: 'Refresh the OpenRouter models catalog cache. Use force=true to bypass TTL.',
    inputSchema: z.object({
      force: z.boolean().optional().describe('Force refresh even if cache is valid'),
    }),
  },
  async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
    log('info', 'sync_catalog called', { force: args.force });

    const forceRefresh = args.force ?? false;
    const cache = getModelsCache();

    if (!forceRefresh && isCacheValid(cache)) {
      const status = getCacheStatus(cache!, 'cache');
      const result: SyncCatalogResult = {
        model_count: cache!.data.length,
        fetched_at: status.fetched_at,
        source: 'cache',
        auth_used: hasApiKey(),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    const modelsResult = await getModels();
    if (!modelsResult.ok) {
      return {
        content: [{ type: 'text', text: JSON.stringify(modelsResult.error, null, 2) }],
      };
    }

    const newCache = setModelsCache(modelsResult.data);
    const result: SyncCatalogResult = {
      model_count: modelsResult.data.length,
      fetched_at: newCache.fetched_at,
      source: 'live',
      auth_used: modelsResult.auth_used,
    };

    log('info', 'Catalog synced', { model_count: result.model_count });

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// Tool: get_model_profile
server.registerTool(
  'get_model_profile',
  {
    description: 'Get detailed profile of a specific model, optionally including endpoints and parameters.',
    inputSchema: z.object({
      model_id: z.string().describe('The model ID (e.g., "anthropic/claude-sonnet-4.5")'),
      include_endpoints: z.boolean().optional().describe('Fetch endpoint-level details'),
      include_parameters: z.boolean().optional().describe('Fetch parameter details'),
    }),
  },
  async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
    log('info', 'get_model_profile called', { model_id: args.model_id });

    // Ensure we have cached models
    let cache = getModelsCache();
    if (!isCacheValid(cache)) {
      const modelsResult = await getModels();
      if (!modelsResult.ok) {
        return {
          content: [{ type: 'text', text: JSON.stringify(modelsResult.error, null, 2) }],
        };
      }
      cache = setModelsCache(modelsResult.data);
    }

    // Find the model
    const model = cache!.data.find(m => m.id === args.model_id);
    if (!model) {
      const error: StructuredError = {
        code: 'INVALID_INPUT',
        message: `Model not found: ${args.model_id}`,
        details: { model_id: args.model_id },
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(error, null, 2) }],
      };
    }

    const result: ModelProfileResult = {
      model,
      fetched_at: cache!.fetched_at,
      auth_used: hasApiKey(),
    };

    // Optionally fetch endpoints
    if (args.include_endpoints) {
      const endpointsResult = await getEndpoints(args.model_id);
      if (endpointsResult.ok) {
        result.endpoints = endpointsResult.data;
      }
    }

    // Optionally fetch parameters
    if (args.include_parameters) {
      const paramsResult = await getParameters(args.model_id);
      if (paramsResult.ok) {
        result.parameters = paramsResult.data;
      }
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// Tool: task2model (main recommendation engine)
server.registerTool(
  'task2model',
  {
    description: `Recommend models for a task. Returns top 100 model IDs filtered by age (<1 year) and ranked by semantic match.

IMPORTANT: Use default parameters (just provide "task"). Only add constraints if user explicitly requests them.

Defaults: limit=100, detail=names_only, max_age_days=365
Optional: hard_constraints.max_price_per_1m, hard_constraints.required_parameters, result.detail (minimal|standard|full)`,
    inputSchema: TaskSpecSchema,
  },
  async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
    log('info', 'task2model called', { task: args.task });

    // Validate input with Zod
    const parseResult = TaskSpecSchema.safeParse(args);
    if (!parseResult.success) {
      const error: StructuredError = {
        code: 'INVALID_INPUT',
        message: 'Invalid TaskSpec',
        details: { errors: parseResult.error.errors },
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(error, null, 2) }],
      };
    }

    const taskSpec = parseResult.data;
    const result = await task2model(taskSpec);

    if (!result.ok) {
      return {
        content: [{ type: 'text', text: JSON.stringify(result.error, null, 2) }],
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result.result, null, 2) }],
    };
  }
);

export async function startServer(): Promise<void> {
  // Initialize cache from disk if available
  await initializeCache();
  log('info', 'Cache initialized');

  // Create stdio transport
  const transport = new StdioServerTransport();

  // Connect server to transport
  await server.connect(transport);
  log('info', 'MCP server started on stdio');
}

export { server };
