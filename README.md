# openrouter-task2model

An MCP (Model Context Protocol) Server that fetches the latest OpenRouter model catalog, uses semantic search (embeddings) to find the best models for your task, and generates request skeletons.

**Key Features:**
- **Semantic Search:** Uses embeddings to match task descriptions to model capabilities
- Real-time model catalog from OpenRouter API
- Declarative hard constraints for dealbreakers
- Request skeleton generation with provider routing configuration
- Freshness gate ensures you always work with up-to-date data

## Installation & Usage

### Run with npx

```bash
# Without API key (limited functionality, no semantic search)
npx -y openrouter-task2model

# With API key (recommended - enables semantic search)
OPENROUTER_API_KEY=sk-or-... npx -y openrouter-task2model
```

### Configure in MCP Client

Add to your MCP configuration (e.g., Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "openrouter-task2model": {
      "command": "npx",
      "args": ["-y", "openrouter-task2model"],
      "env": {
        "OPENROUTER_API_KEY": "sk-or-..."
      }
    }
  }
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | Recommended | OpenRouter API key. Enables semantic search and all endpoints. |
| `CACHE_TTL_MS` | No | Cache TTL in milliseconds (default: 600000 = 10 min) |
| `CACHE_DIR` | No | Cache directory (default: `~/.cache/openrouter-task2model/`) |
| `LOG_LEVEL` | No | Log level: `debug`, `info`, `warn`, `error` (default: `info`) |

## MCP Tools

### 1. `sync_catalog`

Refresh the OpenRouter models catalog cache.

**Input:**
```json
{
  "force": false
}
```

**Output:**
```json
{
  "model_count": 529,
  "fetched_at": "2025-01-15T10:30:00.000Z",
  "source": "live",
  "auth_used": true
}
```

### 2. `get_model_profile`

Get detailed profile of a specific model.

**Input:**
```json
{
  "model_id": "anthropic/claude-sonnet-4",
  "include_endpoints": true,
  "include_parameters": false
}
```

**Output:**
```json
{
  "model": {
    "id": "anthropic/claude-sonnet-4",
    "name": "Claude Sonnet 4",
    "context_length": 200000,
    "pricing": { "prompt": "0.000003", "completion": "0.000015" },
    "supported_parameters": ["tools", "tool_choice", "response_format", "reasoning"]
  },
  "endpoints": [...],
  "fetched_at": "2025-01-15T10:30:00.000Z",
  "auth_used": true
}
```

### 3. `task2model` (Main Tool)

Recommend models based on task description using semantic search. Hard constraints filter out dealbreakers, then models are ranked by embedding similarity.

**Input (TaskSpec):**
```json
{
  "task": "Build an agentic coding assistant with tool use and image understanding",
  "hard_constraints": {
    "input_modalities": ["text", "image"],
    "output_modalities": ["text"],
    "required_parameters": ["tools", "tool_choice"],
    "exclude_free": true,
    "providers": ["anthropic", "openai", "google"]
  },
  "preferences": {
    "routing": "price",
    "prefer_exacto_for_tools": true
  },
  "result": {
    "limit": 10,
    "include_request_skeleton": true,
    "detail": "standard"
  }
}
```

**Output (Task2ModelResult):**
```json
{
  "task": "Build an agentic coding assistant with tool use and image understanding",
  "shortlist": [
    {
      "model_id": "anthropic/claude-sonnet-4",
      "name": "Claude Sonnet 4",
      "created": 1736899200,
      "context_length": 200000,
      "age_days": 45,
      "pricing": { "prompt": "0.000003", "completion": "0.000015" },
      "modalities": { "input": ["text", "image"], "output": ["text"] },
      "supported_parameters": ["tools", "tool_choice", "response_format", "reasoning"],
      "semantic_score": 0.847,
      "why_selected": ["excellent semantic match", "supports tools", "supports reasoning"],
      "request_skeleton": {
        "model": "anthropic/claude-sonnet-4:exacto",
        "messages": [],
        "provider": {
          "require_parameters": true,
          "allow_fallbacks": true,
          "sort": "price"
        }
      }
    }
  ],
  "excluded_summary": {
    "total_models": 529,
    "after_hard_filter": 45,
    "excluded_by": {
      "missing_required_parameters": 380,
      "input_modality_mismatch": 50,
      "free_model": 24,
      "provider_not_allowed": 30
    }
  },
  "catalog": {
    "fetched_at": "2025-01-15T10:30:00.000Z",
    "cache_age_ms": 5000,
    "source": "cache",
    "auth_used": true
  }
}
```

## TaskSpec Schema

### Full Schema

```typescript
type TaskSpec = {
  // Natural language task description (required)
  // This is the main input for semantic search
  task: string;

  // Hard constraints - models must satisfy ALL (dealbreakers only)
  hard_constraints?: {
    required_parameters?: string[];  // e.g. ["tools", "tool_choice"]
    input_modalities?: Array<"text"|"image"|"audio"|"video">;
    output_modalities?: Array<"text"|"image"|"audio"|"video">;
    providers?: string[];          // Whitelist providers e.g. ["anthropic", "openai"]
    exclude_free?: boolean;        // Skip $0 pricing models
  };

  // Preferences - affect secondary sorting
  preferences?: {
    routing?: "price"|"throughput"|"latency";  // default: "price"
    prefer_exacto_for_tools?: boolean;         // default: true
  };

  // Result configuration
  result?: {
    limit?: number;                      // default: 50
    include_endpoints?: boolean;         // default: false
    include_request_skeleton?: boolean;  // default: false
    force_refresh?: boolean;             // default: false
    detail?: "minimal"|"standard"|"full"; // default: "minimal"
  };
};
```

### How Ranking Works

1. **Hard Constraints:** Filter out models that don't meet dealbreakers
2. **Semantic Search:** Rank remaining models by embedding similarity to your task
3. **Secondary Sort:** For models with similar semantic scores, sort by routing preference (price by default)

### Detail Levels

| Level | Description |
|-------|-------------|
| `minimal` | ~8 fields per model: id, name, price, context, supports, age_days, semantic_score |
| `standard` | ~15 fields: + modalities, why_selected, request_skeleton, endpoints_summary |
| `full` | Raw OpenRouter API response |

**Minimal output example:**
```json
{
  "model_id": "google/gemini-2.5-flash",
  "name": "Gemini 2.5 Flash",
  "price": { "prompt": 0.30, "completion": 2.50 },
  "context": 1048576,
  "supports": ["tools", "structured_outputs"],
  "age_days": 45,
  "semantic_score": 0.823
}
```

### Common Parameters

| Parameter | Description |
|-----------|-------------|
| `tools` | Function calling / tool use |
| `tool_choice` | Control tool selection behavior |
| `response_format` | JSON mode / structured output |
| `structured_outputs` | Strict JSON schema validation |
| `reasoning` | Extended thinking / chain-of-thought |
| `temperature` | Sampling temperature |
| `max_tokens` | Maximum completion tokens |

## Semantic Search

The server uses OpenRouter's embedding API (Qwen3-Embedding-8B) to match your task description against model capabilities. Each model is embedded using:
- Model name
- Provider name
- Description
- Natural language capabilities (e.g., "tool use and function calling", "structured JSON output")

Embeddings are cached for 24 hours to minimize API calls.

## Caching & Freshness

- **Models TTL:** 10 minutes (configurable)
- **Embeddings TTL:** 24 hours
- **Force refresh:** Set `result.force_refresh: true` in TaskSpec
- **Manual sync:** Use `sync_catalog` tool with `force: true`

Every `task2model` call includes catalog freshness info:
```json
{
  "catalog": {
    "fetched_at": "2025-01-15T10:30:00.000Z",
    "cache_age_ms": 5000,
    "source": "cache",
    "auth_used": true
  }
}
```

## Request Skeleton

The generated request skeleton is designed to be used directly with OpenRouter:

```json
{
  "model": "anthropic/claude-sonnet-4:exacto",
  "messages": [],
  "provider": {
    "require_parameters": true,
    "allow_fallbacks": true,
    "sort": "price"
  }
}
```

Key features:
- **`:exacto` variant:** Auto-applied when `required_parameters` includes `tools`/`tool_choice` and `prefer_exacto_for_tools` is true
- **`require_parameters: true`:** Ensures providers support all requested parameters
- **`sort`:** Based on routing preference (price/throughput/latency)

## Error Handling

All errors are structured:

```json
{
  "code": "AUTH_REQUIRED",
  "message": "API key required for this operation",
  "details": {
    "hint": "Set OPENROUTER_API_KEY environment variable"
  }
}
```

Error codes:
- `AUTH_REQUIRED` - API key needed
- `NETWORK_ERROR` - Connection failed
- `UPSTREAM_ERROR` - OpenRouter API error
- `INVALID_INPUT` - Invalid TaskSpec or parameters

## License

MIT
