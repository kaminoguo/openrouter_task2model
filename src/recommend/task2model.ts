import type {
  TaskSpec,
  OpenRouterModel,
  Task2ModelResult,
  Task2ModelResultNamesOnly,
  Task2ModelResultFull,
  ShortlistEntry,
  ShortlistEntryMinimal,
  RequestSkeleton,
  EndpointsSummary,
  ExcludedSummary,
  CatalogInfo,
  Modality,
  EmbeddingStatus,
} from '../schema/taskSpec.js';
import {
  getModelsCache,
  setModelsCache,
  isCacheValid,
  getCacheStatus,
  getEmbeddingsCache,
  addEmbeddings,
  getModelEmbedding,
  clearEmbeddingsCache,
} from '../catalog/cache.js';
import { getModels, getEndpoints, hasApiKey, getApiKeyStatus, getEmbeddings, cosineSimilarity } from '../openrouter/client.js';
import type { StructuredError } from '../util/errors.js';

export type Task2ModelOutcome =
  | { ok: true; result: Task2ModelResult }
  | { ok: false; error: StructuredError };

// ============================================================================
// Helper Functions
// ============================================================================

function parseModalities(model: OpenRouterModel): { input: string[]; output: string[] } {
  const modality = model.architecture?.modality || 'text->text';
  const [inputPart, outputPart] = modality.split('->');

  const parseList = (part: string): string[] => {
    if (!part) return ['text'];
    return part.split(/[+,]/).map(s => s.trim().toLowerCase()).filter(Boolean);
  };

  return {
    input: parseList(inputPart),
    output: parseList(outputPart),
  };
}

function parsePrice(priceStr: string | undefined): number {
  if (!priceStr) return Infinity;
  const val = parseFloat(priceStr);
  return isNaN(val) ? Infinity : val * 1_000_000;
}

function getModelAgeDays(model: OpenRouterModel): number {
  if (!model.created) return Infinity;
  const now = Date.now();
  const createdMs = model.created * 1000;
  return Math.floor((now - createdMs) / (1000 * 60 * 60 * 24));
}

function isFreeModel(model: OpenRouterModel): boolean {
  const promptPrice = parseFloat(model.pricing.prompt || '0');
  const completionPrice = parseFloat(model.pricing.completion || '0');
  return promptPrice === 0 && completionPrice === 0;
}

function getProvider(modelId: string): string {
  return modelId.split('/')[0]?.toLowerCase() || '';
}

function getMaxPrice(model: OpenRouterModel): number {
  const prices = [
    parsePrice(model.pricing.prompt),
    parsePrice(model.pricing.completion),
    parsePrice(model.pricing.image),
    parsePrice(model.pricing.request),
  ].filter(p => p !== Infinity && p > 0);

  return prices.length > 0 ? Math.max(...prices) : 0;
}

// ============================================================================
// Embedding Functions - Option 3: Name + Provider + Description + NL Capabilities
// ============================================================================

// Convert supported parameters to natural language
function paramsToNaturalLanguage(params: string[] | undefined): string {
  if (!params || params.length === 0) return '';

  const capabilities: string[] = [];

  if (params.includes('tools') || params.includes('tool_choice')) {
    capabilities.push('tool use and function calling');
  }
  if (params.includes('response_format') || params.includes('structured_outputs')) {
    capabilities.push('structured JSON output');
  }
  if (params.includes('reasoning')) {
    capabilities.push('extended reasoning and chain-of-thought');
  }
  if (params.includes('temperature') || params.includes('top_p')) {
    capabilities.push('adjustable creativity');
  }

  if (capabilities.length === 0) return '';
  return `Good for ${capabilities.join(', ')}.`;
}

// Build embedding text: description only (no name/capabilities to avoid keyword bias)
function buildEmbeddingText(model: OpenRouterModel): string {
  return model.description || '';
}

// Ensure embeddings exist for all models
async function ensureEmbeddings(
  models: OpenRouterModel[]
): Promise<{ embedded: number; failed: number; error?: string }> {
  if (!hasApiKey()) {
    return { embedded: 0, failed: 0, error: 'No API key - embeddings disabled' };
  }

  const cache = getEmbeddingsCache();
  const modelIds = models.map(m => m.id);
  const missingIds = modelIds.filter(id => !cache?.embeddings[id]);
  const alreadyCached = modelIds.length - missingIds.length;

  if (missingIds.length === 0) {
    return { embedded: alreadyCached, failed: 0 };
  }

  const missingModels = models.filter(m => missingIds.includes(m.id));
  const texts = missingModels.map(m => buildEmbeddingText(m));

  // Batch fetch embeddings (max 100 at a time)
  const BATCH_SIZE = 100;
  const newEmbeddings: Record<string, number[]> = {};
  let fetchError: string | undefined;

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batchTexts = texts.slice(i, i + BATCH_SIZE);
    const batchIds = missingIds.slice(i, i + BATCH_SIZE);

    const result = await getEmbeddings(batchTexts);
    if (!result.ok) {
      fetchError = result.error.message;
      continue; // Try remaining batches
    }

    for (let j = 0; j < batchIds.length; j++) {
      newEmbeddings[batchIds[j]] = result.data[j];
    }
  }

  const newCount = Object.keys(newEmbeddings).length;
  if (newCount > 0) {
    addEmbeddings(newEmbeddings);
  }

  return {
    embedded: alreadyCached + newCount,
    failed: missingIds.length - newCount,
    error: fetchError,
  };
}

// ============================================================================
// Hard Constraints (Dealbreakers Only)
// ============================================================================

function meetsHardConstraints(
  model: OpenRouterModel,
  constraints: TaskSpec['hard_constraints'],
  exclusionReasons: Map<string, number>
): boolean {
  // Max age filter always applies (default 365 days)
  const maxAgeDays = constraints?.max_age_days ?? 365;
  const modelAge = getModelAgeDays(model);
  if (modelAge > maxAgeDays) {
    exclusionReasons.set('too_old', (exclusionReasons.get('too_old') || 0) + 1);
    return false;
  }

  if (!constraints) return true;

  const modalities = parseModalities(model);

  // Required parameters
  if (constraints.required_parameters && constraints.required_parameters.length > 0) {
    const supportedParams = new Set(model.supported_parameters || []);
    const missingParams = constraints.required_parameters.filter(p => !supportedParams.has(p));
    if (missingParams.length > 0) {
      exclusionReasons.set('missing_required_parameters', (exclusionReasons.get('missing_required_parameters') || 0) + 1);
      return false;
    }
  }

  // Input modalities
  if (constraints.input_modalities && constraints.input_modalities.length > 0) {
    const hasAllInputs = constraints.input_modalities.every(
      (m: Modality) => modalities.input.includes(m)
    );
    if (!hasAllInputs) {
      exclusionReasons.set('input_modality_mismatch', (exclusionReasons.get('input_modality_mismatch') || 0) + 1);
      return false;
    }
  }

  // Output modalities
  if (constraints.output_modalities && constraints.output_modalities.length > 0) {
    const hasAllOutputs = constraints.output_modalities.every(
      (m: Modality) => modalities.output.includes(m)
    );
    if (!hasAllOutputs) {
      exclusionReasons.set('output_modality_mismatch', (exclusionReasons.get('output_modality_mismatch') || 0) + 1);
      return false;
    }
  }

  // Provider whitelist
  if (constraints.providers && constraints.providers.length > 0) {
    const modelProvider = getProvider(model.id);
    const allowedProviders = constraints.providers.map(p => p.toLowerCase());
    if (!allowedProviders.includes(modelProvider)) {
      exclusionReasons.set('provider_not_allowed', (exclusionReasons.get('provider_not_allowed') || 0) + 1);
      return false;
    }
  }

  // Exclude free models
  if (constraints.exclude_free && isFreeModel(model)) {
    exclusionReasons.set('free_model', (exclusionReasons.get('free_model') || 0) + 1);
    return false;
  }

  // Max price filter (inclusive: <= max_price)
  if (constraints.max_price_per_1m !== undefined) {
    const totalPrice = getMaxPrice(model);
    if (totalPrice > constraints.max_price_per_1m) {
      exclusionReasons.set('too_expensive', (exclusionReasons.get('too_expensive') || 0) + 1);
      return false;
    }
  }

  return true;
}

// ============================================================================
// Secondary Sort (by routing preference)
// ============================================================================

function secondarySort(
  models: Array<{ model: OpenRouterModel; semanticScore: number }>,
  routing: 'price' | 'throughput' | 'latency'
): void {
  // Sort by semantic score first (descending), then by routing preference
  models.sort((a, b) => {
    // Primary: semantic score (descending)
    const scoreDiff = b.semanticScore - a.semanticScore;
    if (Math.abs(scoreDiff) > 0.01) return scoreDiff;

    // Secondary: routing preference (for ties)
    if (routing === 'price') {
      return getMaxPrice(a.model) - getMaxPrice(b.model);
    }
    // Note: throughput/latency handled via provider.sort in skeleton
    return 0;
  });
}

// ============================================================================
// Result Building
// ============================================================================

function hasExactoVariant(modelId: string, allModels: OpenRouterModel[]): boolean {
  const exactoId = `${modelId}:exacto`;
  return allModels.some(m => m.id === exactoId);
}

function generateSkeleton(
  model: OpenRouterModel,
  allModels: OpenRouterModel[],
  preferences: TaskSpec['preferences'],
  requiredParams: string[] | undefined
): RequestSkeleton {
  const preferExacto = preferences?.prefer_exacto_for_tools ?? true;
  const routing = preferences?.routing ?? 'price';

  let modelIdToUse = model.id;
  if (preferExacto && requiredParams) {
    const needsExacto = requiredParams.some(p => ['tools', 'tool_choice'].includes(p));
    if (needsExacto && hasExactoVariant(model.id, allModels)) {
      modelIdToUse = `${model.id}:exacto`;
    }
  }

  return {
    model: modelIdToUse,
    messages: [],
    provider: {
      require_parameters: true,
      allow_fallbacks: true,
      sort: routing,
    },
  };
}

function generateReasons(semanticScore: number, model: OpenRouterModel): string[] {
  const reasons: string[] = [];

  if (semanticScore >= 0.8) {
    reasons.push('excellent semantic match');
  } else if (semanticScore >= 0.6) {
    reasons.push('good semantic match');
  }

  const params = model.supported_parameters || [];
  if (params.includes('tools')) reasons.push('supports tools');
  if (params.includes('reasoning')) reasons.push('supports reasoning');

  if (reasons.length === 0) {
    reasons.push(`semantic: ${(semanticScore * 100).toFixed(0)}%`);
  }

  return reasons;
}

async function checkEndpoints(
  modelId: string,
  requiredParams: string[] | undefined,
  includeEndpoints: boolean
): Promise<{ summary?: EndpointsSummary }> {
  if (!includeEndpoints) return {};

  const result = await getEndpoints(modelId);
  if (!result.ok || result.data.length === 0) return {};

  const summary: EndpointsSummary = {
    count: result.data.length,
    endpoints: result.data.map(ep => ({
      name: ep.name,
      supports_required_params: !requiredParams || requiredParams.length === 0 ||
        requiredParams.every(p => (ep.supported_parameters || []).includes(p)),
      context_length: ep.context_length,
    })),
  };

  return { summary };
}

// ============================================================================
// Main Function
// ============================================================================

export async function task2model(spec: TaskSpec): Promise<Task2ModelOutcome> {
  const forceRefresh = spec.result?.force_refresh ?? false;
  const limit = spec.result?.limit ?? 100;
  const includeEndpoints = spec.result?.include_endpoints ?? false;
  const includeRequestSkeleton = spec.result?.include_request_skeleton ?? false;
  const detailLevel = spec.result?.detail ?? 'names_only';
  const routing = spec.preferences?.routing ?? 'price';
  const requiredParams = spec.hard_constraints?.required_parameters;

  // Step 1: Ensure models cache is valid
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

  // Step 2: Hard constraint filtering
  const filtered = allModels.filter(model =>
    meetsHardConstraints(model, spec.hard_constraints, exclusionReasons)
  );

  // Step 3: Generate fresh embeddings (no cache - always use latest format)
  clearEmbeddingsCache();

  const keyStatus = getApiKeyStatus();
  const embeddingStatus: EmbeddingStatus = {
    enabled: keyStatus.valid,
    api_key_status: keyStatus.format,
    task_embedded: false,
    models_embedded: 0,
    models_failed: 0,
  };

  if (keyStatus.valid) {
    const modelEmbResult = await ensureEmbeddings(filtered);
    embeddingStatus.models_embedded = modelEmbResult.embedded;
    embeddingStatus.models_failed = modelEmbResult.failed;
    if (modelEmbResult.error) {
      embeddingStatus.error = modelEmbResult.error;
    }
  }

  // Step 4: Get task embedding
  let taskEmbedding: number[] | null = null;
  if (keyStatus.valid) {
    const result = await getEmbeddings([spec.task]);
    if (result.ok && result.data.length > 0) {
      taskEmbedding = result.data[0];
      embeddingStatus.task_embedded = true;
    } else if (!result.ok) {
      embeddingStatus.error = result.error.message;
    }
  }

  // Step 5: Calculate semantic scores
  const scored = filtered.map(model => {
    let semanticScore = 0.5; // Default if no embedding

    if (taskEmbedding) {
      const modelEmbedding = getModelEmbedding(model.id);
      if (modelEmbedding) {
        const similarity = cosineSimilarity(taskEmbedding, modelEmbedding);
        semanticScore = (similarity + 1) / 2; // Normalize -1..1 to 0..1
      }
    }

    return { model, semanticScore };
  });

  // Step 6: Sort by semantic score + secondary routing preference
  secondarySort(scored, routing);

  // Step 7: Take top N
  const shortlisted = scored.slice(0, limit);

  // Step 8: Build result based on detail level

  // names_only: Ultra compact - just model IDs
  if (detailLevel === 'names_only') {
    const models = shortlisted.map(({ model }) => model.id);

    // Calculate price range
    const prices = shortlisted.map(({ model }) => getMaxPrice(model));
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const formatPrice = (p: number) => p < 1 ? `$${p.toFixed(2)}` : `$${p.toFixed(0)}`;
    const priceRange = `${formatPrice(minPrice)}-${formatPrice(maxPrice)}/1M`;

    const result: Task2ModelResultNamesOnly = {
      task: spec.task,
      models,
      count: models.length,
      price_range: priceRange,
      note: 'Ranked by description similarity. Does not predict actual task performance. Benchmark before production use.',
    };

    return { ok: true, result };
  }

  // Other detail levels return full result with shortlist
  let shortlist: (ShortlistEntry | ShortlistEntryMinimal | OpenRouterModel)[];

  if (detailLevel === 'minimal') {
    shortlist = shortlisted.map(({ model, semanticScore }) => {
      const promptPrice = parseFloat(model.pricing.prompt || '0') * 1_000_000;
      const completionPrice = parseFloat(model.pricing.completion || '0') * 1_000_000;
      return {
        model_id: model.id,
        name: model.name,
        price: { prompt: promptPrice, completion: completionPrice },
        context: model.context_length,
        supports: model.supported_parameters || [],
        age_days: getModelAgeDays(model),
        semantic_score: semanticScore,
      };
    });
  } else if (detailLevel === 'full') {
    shortlist = shortlisted.map(({ model }) => model);
  } else {
    // Standard format
    shortlist = await Promise.all(
      shortlisted.map(async ({ model, semanticScore }) => {
        const modalities = parseModalities(model);
        const reasons = generateReasons(semanticScore, model);
        const endpointCheck = await checkEndpoints(model.id, requiredParams, includeEndpoints);

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
          semantic_score: semanticScore,
          why_selected: reasons,
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

  return {
    ok: true,
    result: {
      task: spec.task,
      shortlist,
      excluded_summary: excludedSummary,
      catalog: catalogInfo,
      embeddings: embeddingStatus,
    },
  };
}
