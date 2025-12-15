import type {
  TaskSpec,
  OpenRouterModel,
  OpenRouterEndpoint,
  Task2ModelResult,
  ShortlistEntry,
  ShortlistEntryMinimal,
  RequestSkeleton,
  EndpointsSummary,
  ExcludedSummary,
  CatalogInfo,
  Modality,
} from '../schema/taskSpec.js';
import {
  getModelsCache,
  setModelsCache,
  isCacheValid,
  getCacheStatus,
} from '../catalog/cache.js';
import { getModels, getEndpoints, hasApiKey } from '../openrouter/client.js';
import type { StructuredError } from '../util/errors.js';

export type Task2ModelOutcome =
  | { ok: true; result: Task2ModelResult }
  | { ok: false; error: StructuredError };

// Parse modalities from model architecture
function parseModalities(model: OpenRouterModel): { input: string[]; output: string[] } {
  const modality = model.architecture?.modality || 'text->text';
  const [inputPart, outputPart] = modality.split('->');

  const parseList = (part: string): string[] => {
    if (!part) return ['text'];
    // Handle formats like "text+image" or "text,image" or just "text"
    return part.split(/[+,]/).map(s => s.trim().toLowerCase()).filter(Boolean);
  };

  return {
    input: parseList(inputPart),
    output: parseList(outputPart),
  };
}

// Parse price string to number (per 1M tokens)
function parsePrice(priceStr: string | undefined): number {
  if (!priceStr) return Infinity;
  const val = parseFloat(priceStr);
  return isNaN(val) ? Infinity : val * 1_000_000; // Convert per-token to per-1M
}

// Calculate model age in days
function getModelAgeDays(model: OpenRouterModel): number {
  if (!model.created) return Infinity; // Unknown age treated as very old
  const now = Date.now();
  const createdMs = model.created * 1000; // Convert Unix timestamp to ms
  return Math.floor((now - createdMs) / (1000 * 60 * 60 * 24));
}

// Check if model is free (both prompt and completion are 0)
function isFreeModel(model: OpenRouterModel): boolean {
  const promptPrice = parseFloat(model.pricing.prompt || '0');
  const completionPrice = parseFloat(model.pricing.completion || '0');
  return promptPrice === 0 && completionPrice === 0;
}

// Extract provider from model ID (e.g., "anthropic/claude-3" -> "anthropic")
function getProvider(modelId: string): string {
  return modelId.split('/')[0]?.toLowerCase() || '';
}

// Check if model meets hard constraints
function meetsHardConstraints(
  model: OpenRouterModel,
  constraints: TaskSpec['hard_constraints'],
  exclusionReasons: Map<string, number>
): boolean {
  if (!constraints) return true;

  const modalities = parseModalities(model);

  // Check input modalities
  if (constraints.input_modalities && constraints.input_modalities.length > 0) {
    const hasAllInputs = constraints.input_modalities.every(
      (m: Modality) => modalities.input.includes(m)
    );
    if (!hasAllInputs) {
      exclusionReasons.set('input_modality_mismatch', (exclusionReasons.get('input_modality_mismatch') || 0) + 1);
      return false;
    }
  }

  // Check output modalities
  if (constraints.output_modalities && constraints.output_modalities.length > 0) {
    const hasAllOutputs = constraints.output_modalities.every(
      (m: Modality) => modalities.output.includes(m)
    );
    if (!hasAllOutputs) {
      exclusionReasons.set('output_modality_mismatch', (exclusionReasons.get('output_modality_mismatch') || 0) + 1);
      return false;
    }
  }

  // Check context length
  if (constraints.min_context_length !== undefined) {
    if (model.context_length < constraints.min_context_length) {
      exclusionReasons.set('context_too_small', (exclusionReasons.get('context_too_small') || 0) + 1);
      return false;
    }
  }

  // Check price
  if (constraints.max_price) {
    const promptPrice = parsePrice(model.pricing.prompt);
    const completionPrice = parsePrice(model.pricing.completion);
    const requestPrice = model.pricing.request ? parseFloat(model.pricing.request) : 0;

    if (constraints.max_price.prompt_per_1m !== undefined && promptPrice > constraints.max_price.prompt_per_1m) {
      exclusionReasons.set('prompt_price_too_high', (exclusionReasons.get('prompt_price_too_high') || 0) + 1);
      return false;
    }
    if (constraints.max_price.completion_per_1m !== undefined && completionPrice > constraints.max_price.completion_per_1m) {
      exclusionReasons.set('completion_price_too_high', (exclusionReasons.get('completion_price_too_high') || 0) + 1);
      return false;
    }
    if (constraints.max_price.request !== undefined && requestPrice > constraints.max_price.request) {
      exclusionReasons.set('request_price_too_high', (exclusionReasons.get('request_price_too_high') || 0) + 1);
      return false;
    }
  }

  // Check required parameters
  if (constraints.required_parameters && constraints.required_parameters.length > 0) {
    const supportedParams = new Set(model.supported_parameters || []);
    const missingParams = constraints.required_parameters.filter(p => !supportedParams.has(p));
    if (missingParams.length > 0) {
      exclusionReasons.set('missing_required_parameters', (exclusionReasons.get('missing_required_parameters') || 0) + 1);
      return false;
    }
  }

  // Check minimum age (exclude new/untested models)
  if (constraints.min_age_days !== undefined) {
    const ageDays = getModelAgeDays(model);
    if (ageDays < constraints.min_age_days) {
      exclusionReasons.set('too_new', (exclusionReasons.get('too_new') || 0) + 1);
      return false;
    }
  }

  // Check exclude free models
  if (constraints.exclude_free && isFreeModel(model)) {
    exclusionReasons.set('free_model', (exclusionReasons.get('free_model') || 0) + 1);
    return false;
  }

  // Check provider whitelist
  if (constraints.providers && constraints.providers.length > 0) {
    const modelProvider = getProvider(model.id);
    const allowedProviders = constraints.providers.map(p => p.toLowerCase());
    if (!allowedProviders.includes(modelProvider)) {
      exclusionReasons.set('provider_not_allowed', (exclusionReasons.get('provider_not_allowed') || 0) + 1);
      return false;
    }
  }

  return true;
}

// Calculate parameter coverage score (for sorting)
function getParamCoverageScore(model: OpenRouterModel, requiredParams: string[] | undefined): number {
  if (!requiredParams || requiredParams.length === 0) return 1;
  const supportedParams = new Set(model.supported_parameters || []);
  const covered = requiredParams.filter(p => supportedParams.has(p)).length;
  return covered / requiredParams.length;
}

// Get total price for sorting
function getTotalPrice(model: OpenRouterModel): number {
  const promptPrice = parsePrice(model.pricing.prompt);
  const completionPrice = parsePrice(model.pricing.completion);
  return promptPrice + completionPrice;
}

// Sort models by preferences
function sortModels(
  models: OpenRouterModel[],
  preferences: TaskSpec['preferences'],
  requiredParams: string[] | undefined
): OpenRouterModel[] {
  const preferNewer = preferences?.prefer_newer ?? true;
  const routing = preferences?.routing ?? 'price';

  return [...models].sort((a, b) => {
    // 1. Parameter coverage (descending)
    const coverageA = getParamCoverageScore(a, requiredParams);
    const coverageB = getParamCoverageScore(b, requiredParams);
    if (coverageA !== coverageB) return coverageB - coverageA;

    // 2. Routing preference
    if (routing === 'price') {
      const priceA = getTotalPrice(a);
      const priceB = getTotalPrice(b);
      if (priceA !== priceB) return priceA - priceB;
    }
    // Note: throughput/latency are handled via provider.sort in skeleton, not here

    // 3. Created date (descending, if prefer_newer)
    if (preferNewer) {
      const createdA = a.created ?? 0;
      const createdB = b.created ?? 0;
      if (createdA !== createdB) return createdB - createdA;
    }

    // 4. Context length (descending, tie-breaker)
    return b.context_length - a.context_length;
  });
}

// Check if :exacto variant exists
function hasExactoVariant(modelId: string, allModels: OpenRouterModel[]): boolean {
  const exactoId = `${modelId}:exacto`;
  return allModels.some(m => m.id === exactoId);
}

// Generate request skeleton
function generateSkeleton(
  model: OpenRouterModel,
  allModels: OpenRouterModel[],
  preferences: TaskSpec['preferences'],
  requiredParams: string[] | undefined
): RequestSkeleton {
  const preferExacto = preferences?.prefer_exacto_for_tools ?? true;
  const routing = preferences?.routing ?? 'price';

  // Determine if we should use :exacto variant
  let modelIdToUse = model.id;
  if (preferExacto && requiredParams) {
    const needsExacto = requiredParams.some(p => ['tools', 'tool_choice'].includes(p));
    if (needsExacto && hasExactoVariant(model.id, allModels)) {
      modelIdToUse = `${model.id}:exacto`;
    }
  }

  const skeleton: RequestSkeleton = {
    model: modelIdToUse,
    messages: [],
    provider: {
      require_parameters: true,
      allow_fallbacks: true,
    },
  };

  // Set provider sort based on routing
  if (routing === 'throughput') {
    skeleton.provider.sort = 'throughput';
  } else if (routing === 'latency') {
    skeleton.provider.sort = 'latency';
  } else {
    skeleton.provider.sort = 'price';
  }

  return skeleton;
}

// Generate why_selected reasons
function generateReasons(
  model: OpenRouterModel,
  constraints: TaskSpec['hard_constraints']
): string[] {
  const reasons: string[] = [];

  if (constraints?.required_parameters && constraints.required_parameters.length > 0) {
    const supported = model.supported_parameters || [];
    const matched = constraints.required_parameters.filter(p => supported.includes(p));
    if (matched.length > 0) {
      reasons.push(`supports ${matched.join('+')}`);
    }
  }

  if (constraints?.min_context_length !== undefined) {
    reasons.push(`context>=${constraints.min_context_length / 1000}k`);
  }

  if (constraints?.max_price) {
    reasons.push('within budget');
  }

  if (constraints?.input_modalities || constraints?.output_modalities) {
    reasons.push('modality match');
  }

  if (reasons.length === 0) {
    reasons.push('meets all constraints');
  }

  return reasons;
}

// Check endpoints for parameter support
async function checkEndpoints(
  modelId: string,
  requiredParams: string[] | undefined,
  includeEndpoints: boolean
): Promise<{ summary?: EndpointsSummary; risk?: string }> {
  if (!includeEndpoints) {
    return { risk: 'endpoints not checked' };
  }

  const result = await getEndpoints(modelId);
  if (!result.ok) {
    return { risk: 'failed to fetch endpoints' };
  }

  const endpoints = result.data;
  if (endpoints.length === 0) {
    return { risk: 'no endpoints found' };
  }

  const summary: EndpointsSummary = {
    count: endpoints.length,
    endpoints: endpoints.map(ep => {
      const supportsRequired = !requiredParams || requiredParams.length === 0 ||
        requiredParams.every(p => (ep.supported_parameters || []).includes(p));
      return {
        name: ep.name,
        supports_required_params: supportsRequired,
        context_length: ep.context_length,
      };
    }),
  };

  const hasRisk = summary.endpoints.some(ep => !ep.supports_required_params);
  return {
    summary,
    risk: hasRisk ? 'endpoint_param_risk' : undefined,
  };
}

// Build minimal format entry
function buildMinimalEntry(model: OpenRouterModel): ShortlistEntryMinimal {
  const promptPrice = parseFloat(model.pricing.prompt || '0') * 1_000_000;
  const completionPrice = parseFloat(model.pricing.completion || '0') * 1_000_000;
  return {
    model_id: model.id,
    name: model.name,
    price: { prompt: promptPrice, completion: completionPrice },
    context: model.context_length,
    supports: model.supported_parameters || [],
    age_days: getModelAgeDays(model),
  };
}

// Main task2model function
export async function task2model(spec: TaskSpec): Promise<Task2ModelOutcome> {
  const forceRefresh = spec.result?.force_refresh ?? false;
  const limit = spec.result?.limit ?? 8;
  const includeEndpoints = spec.result?.include_endpoints ?? false;
  const includeRequestSkeleton = spec.result?.include_request_skeleton ?? true;
  const detailLevel = spec.result?.detail ?? 'standard';
  const requiredParams = spec.hard_constraints?.required_parameters;

  // Freshness gate: ensure cache is valid
  let cache = getModelsCache();
  let source: 'live' | 'cache' = 'cache';

  if (!isCacheValid(cache) || forceRefresh) {
    const modelsResult = await getModels();
    if (!modelsResult.ok) {
      return { ok: false, error: modelsResult.error };
    }
    cache = setModelsCache(modelsResult.data);
    source = 'live';
  }

  if (!cache) {
    return {
      ok: false,
      error: {
        code: 'NETWORK_ERROR',
        message: 'Failed to fetch models and no cache available',
      },
    };
  }

  const allModels = cache.data;
  const totalModels = allModels.length;
  const exclusionReasons = new Map<string, number>();

  // Hard constraint filtering
  const filtered = allModels.filter(model =>
    meetsHardConstraints(model, spec.hard_constraints, exclusionReasons)
  );

  // Sort by preferences
  const sorted = sortModels(filtered, spec.preferences, requiredParams);

  // Take top N
  const shortlisted = sorted.slice(0, limit);

  // Build shortlist entries based on detail level
  let shortlist: (ShortlistEntry | ShortlistEntryMinimal | OpenRouterModel)[];

  if (detailLevel === 'minimal') {
    // Minimal: compact format, no async operations
    shortlist = shortlisted.map(model => buildMinimalEntry(model));
  } else if (detailLevel === 'full') {
    // Full: return raw OpenRouter model data
    shortlist = shortlisted.map(model => model);
  } else {
    // Standard: default format with reasons and optional extras
    shortlist = await Promise.all(
      shortlisted.map(async model => {
        const modalities = parseModalities(model);
        const reasons = generateReasons(model, spec.hard_constraints);
        const risks: string[] = [];

        // Check endpoints if requested
        const endpointCheck = await checkEndpoints(model.id, requiredParams, includeEndpoints);
        if (endpointCheck.risk) {
          risks.push(endpointCheck.risk);
        }

        const entry: ShortlistEntry = {
          model_id: model.id,
          name: model.name,
          created: model.created,
          context_length: model.context_length,
          age_days: getModelAgeDays(model),
          pricing: {
            prompt: model.pricing.prompt,
            completion: model.pricing.completion,
            request: model.pricing.request,
          },
          modalities: {
            input: modalities.input,
            output: modalities.output,
          },
          supported_parameters: model.supported_parameters,
          why_selected: reasons,
          risks: risks.length > 0 ? risks : undefined,
        };

        if (includeRequestSkeleton) {
          entry.request_skeleton = generateSkeleton(model, allModels, spec.preferences, requiredParams);
        }

        if (endpointCheck.summary) {
          entry.endpoints_summary = endpointCheck.summary;
        }

        return entry;
      })
    );
  }

  const excludedSummary: ExcludedSummary = {
    total_models: totalModels,
    after_hard_filter: filtered.length,
    excluded_by: Object.fromEntries(exclusionReasons),
  };

  const cacheStatus = getCacheStatus(cache, source);
  const catalogInfo: CatalogInfo = {
    fetched_at: cacheStatus.fetched_at,
    cache_age_ms: cacheStatus.cache_age_ms,
    source: cacheStatus.source,
    auth_used: hasApiKey(),
  };

  const result: Task2ModelResult = {
    task: spec.task,
    shortlist,
    excluded_summary: excludedSummary,
    catalog: catalogInfo,
  };

  return { ok: true, result };
}
