import type {
  TaskSpec,
  OpenRouterModel,
  Task2ModelResult,
  ShortlistEntry,
  ShortlistEntryMinimal,
  RequestSkeleton,
  EndpointsSummary,
  ExcludedSummary,
  CatalogInfo,
  Modality,
  ScoreBreakdown,
  ScoringWeights,
} from '../schema/taskSpec.js';
import {
  getModelsCache,
  setModelsCache,
  isCacheValid,
  getCacheStatus,
  getEmbeddingsCache,
  addEmbeddings,
  getModelEmbedding,
} from '../catalog/cache.js';
import { getModels, getEndpoints, hasApiKey, getEmbeddings, cosineSimilarity } from '../openrouter/client.js';
import type { StructuredError } from '../util/errors.js';

export type Task2ModelOutcome =
  | { ok: true; result: Task2ModelResult }
  | { ok: false; error: StructuredError };

// Default scoring weights
const DEFAULT_WEIGHTS: ScoringWeights = {
  semantic: 0.35,
  price: 0.20,
  parameters: 0.25,
  recency: 0.10,
  context: 0.10,
};

// ============================================================================
// Helper Functions
// ============================================================================

// Parse modalities from model architecture
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

// Parse price string to number (per 1M tokens)
function parsePrice(priceStr: string | undefined): number {
  if (!priceStr) return Infinity;
  const val = parseFloat(priceStr);
  return isNaN(val) ? Infinity : val * 1_000_000;
}

// Calculate model age in days
function getModelAgeDays(model: OpenRouterModel): number {
  if (!model.created) return Infinity;
  const now = Date.now();
  const createdMs = model.created * 1000;
  return Math.floor((now - createdMs) / (1000 * 60 * 60 * 24));
}

// Check if model is free
function isFreeModel(model: OpenRouterModel): boolean {
  const promptPrice = parseFloat(model.pricing.prompt || '0');
  const completionPrice = parseFloat(model.pricing.completion || '0');
  return promptPrice === 0 && completionPrice === 0;
}

// Extract provider from model ID
function getProvider(modelId: string): string {
  return modelId.split('/')[0]?.toLowerCase() || '';
}

// Get total price for scoring
function getTotalPrice(model: OpenRouterModel): number {
  const promptPrice = parsePrice(model.pricing.prompt);
  const completionPrice = parsePrice(model.pricing.completion);
  return promptPrice + completionPrice;
}

// ============================================================================
// Embedding Functions
// ============================================================================

// Build rich embedding text for a model
function buildEmbeddingText(model: OpenRouterModel): string {
  const provider = getProvider(model.id);
  const params = model.supported_parameters?.join(', ') || 'none';
  const modalities = parseModalities(model);
  const inputMods = modalities.input.join(', ');
  const outputMods = modalities.output.join(', ');

  // Create semantically rich text
  const parts = [
    model.name,
    `by ${provider}`,
    model.description || '',
    `Supports: ${params}`,
    `Input: ${inputMods}`,
    `Output: ${outputMods}`,
    `Context: ${model.context_length} tokens`,
  ];

  return parts.filter(Boolean).join('. ');
}

// Ensure embeddings exist for all models, fetch missing ones
async function ensureEmbeddings(
  models: OpenRouterModel[]
): Promise<{ ok: true } | { ok: false; error: StructuredError }> {
  if (!hasApiKey()) {
    // No API key - skip embeddings, will use 0 for semantic score
    return { ok: true };
  }

  const cache = getEmbeddingsCache();
  const modelIds = models.map(m => m.id);

  // Find models without embeddings
  const missingIds = modelIds.filter(id => !cache?.embeddings[id]);

  if (missingIds.length === 0) {
    return { ok: true };
  }

  // Build embedding texts for missing models
  const missingModels = models.filter(m => missingIds.includes(m.id));
  const texts = missingModels.map(m => buildEmbeddingText(m));

  // Batch fetch embeddings (max 100 at a time to avoid API limits)
  const BATCH_SIZE = 100;
  const newEmbeddings: Record<string, number[]> = {};

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batchTexts = texts.slice(i, i + BATCH_SIZE);
    const batchIds = missingIds.slice(i, i + BATCH_SIZE);

    const result = await getEmbeddings(batchTexts);
    if (!result.ok) {
      // Embedding failed - continue without semantic scoring
      console.error('Failed to fetch embeddings:', result.error);
      return { ok: true }; // Don't fail the whole operation
    }

    for (let j = 0; j < batchIds.length; j++) {
      newEmbeddings[batchIds[j]] = result.data[j];
    }
  }

  // Update cache
  addEmbeddings(newEmbeddings);
  return { ok: true };
}

// Get semantic similarity score between task and model
async function getSemanticScore(
  taskText: string,
  modelId: string
): Promise<number> {
  if (!hasApiKey()) return 0;

  const modelEmbedding = getModelEmbedding(modelId);
  if (!modelEmbedding) return 0;

  // Get task embedding
  const result = await getEmbeddings([taskText]);
  if (!result.ok || result.data.length === 0) return 0;

  const taskEmbedding = result.data[0];
  const similarity = cosineSimilarity(taskEmbedding, modelEmbedding);

  // Normalize to 0-1 range (cosine similarity is -1 to 1)
  return (similarity + 1) / 2;
}

// ============================================================================
// Scoring Functions
// ============================================================================

// Calculate price score (0-1, lower price = higher score)
function getPriceScore(model: OpenRouterModel, targetPrice?: { prompt_per_1m?: number; completion_per_1m?: number }): number {
  const totalPrice = getTotalPrice(model);

  if (totalPrice === 0) return 1; // Free is best for price
  if (totalPrice === Infinity) return 0;

  if (targetPrice) {
    const targetTotal = (targetPrice.prompt_per_1m || 0) + (targetPrice.completion_per_1m || 0);
    if (targetTotal > 0) {
      // Score based on how close to target (or below)
      if (totalPrice <= targetTotal) return 1;
      // Gradual degradation up to 3x target price
      const ratio = totalPrice / targetTotal;
      return Math.max(0, 1 - (ratio - 1) / 2);
    }
  }

  // Default: score based on absolute price (cheaper = better)
  // Assume $10/1M is "average", score degrades linearly
  const avgPrice = 10;
  if (totalPrice <= avgPrice) return 1;
  return Math.max(0, 1 - (totalPrice - avgPrice) / (avgPrice * 10));
}

// Calculate parameter coverage score (0-1)
function getParamScore(model: OpenRouterModel, requiredParams?: string[]): number {
  if (!requiredParams || requiredParams.length === 0) return 1;
  const supportedParams = new Set(model.supported_parameters || []);
  const covered = requiredParams.filter(p => supportedParams.has(p)).length;
  return covered / requiredParams.length;
}

// Calculate recency score (0-1, newer = higher if preferred)
function getRecencyScore(model: OpenRouterModel, preferNewer: boolean, minAgeDays?: number): number {
  const ageDays = getModelAgeDays(model);

  if (ageDays === Infinity) return 0.5; // Unknown age = neutral

  // If there's a minimum age preference, penalize newer models
  if (minAgeDays !== undefined && ageDays < minAgeDays) {
    // Soft penalty: linearly decrease score for models younger than minAgeDays
    return Math.max(0.2, ageDays / minAgeDays);
  }

  if (preferNewer) {
    // Newer is better: models < 30 days get 1.0, degrades over 2 years
    if (ageDays <= 30) return 1;
    return Math.max(0.3, 1 - (ageDays - 30) / 700);
  } else {
    // Older is better (more stable): models > 180 days get 1.0
    if (ageDays >= 180) return 1;
    return Math.max(0.5, ageDays / 180);
  }
}

// Calculate context length score (0-1)
function getContextScore(model: OpenRouterModel, targetContext?: number): number {
  if (!targetContext) return 1; // No target = all equal

  if (model.context_length >= targetContext) return 1;

  // Soft penalty for not meeting target
  return model.context_length / targetContext;
}

// Calculate total weighted score
function calculateScore(
  model: OpenRouterModel,
  semanticScore: number,
  spec: TaskSpec,
  weights: ScoringWeights
): ScoreBreakdown {
  const priceScore = getPriceScore(model, spec.soft_constraints?.target_price);
  const paramScore = getParamScore(model, spec.hard_constraints?.required_parameters);
  const recencyScore = getRecencyScore(
    model,
    spec.preferences?.prefer_newer ?? true,
    spec.soft_constraints?.min_age_days
  );
  const contextScore = getContextScore(model, spec.soft_constraints?.target_context_length);

  const total =
    weights.semantic * semanticScore +
    weights.price * priceScore +
    weights.parameters * paramScore +
    weights.recency * recencyScore +
    weights.context * contextScore;

  return {
    semantic: semanticScore,
    price: priceScore,
    parameters: paramScore,
    recency: recencyScore,
    context: contextScore,
    total,
  };
}

// ============================================================================
// Hard Constraints (True Dealbreakers Only)
// ============================================================================

function meetsHardConstraints(
  model: OpenRouterModel,
  constraints: TaskSpec['hard_constraints'],
  exclusionReasons: Map<string, number>
): boolean {
  if (!constraints) return true;

  const modalities = parseModalities(model);

  // Check required parameters (dealbreaker - can't fake tool support)
  if (constraints.required_parameters && constraints.required_parameters.length > 0) {
    const supportedParams = new Set(model.supported_parameters || []);
    const missingParams = constraints.required_parameters.filter(p => !supportedParams.has(p));
    if (missingParams.length > 0) {
      exclusionReasons.set('missing_required_parameters', (exclusionReasons.get('missing_required_parameters') || 0) + 1);
      return false;
    }
  }

  // Check input modalities (dealbreaker - can't process unsupported input)
  if (constraints.input_modalities && constraints.input_modalities.length > 0) {
    const hasAllInputs = constraints.input_modalities.every(
      (m: Modality) => modalities.input.includes(m)
    );
    if (!hasAllInputs) {
      exclusionReasons.set('input_modality_mismatch', (exclusionReasons.get('input_modality_mismatch') || 0) + 1);
      return false;
    }
  }

  // Check output modalities (dealbreaker)
  if (constraints.output_modalities && constraints.output_modalities.length > 0) {
    const hasAllOutputs = constraints.output_modalities.every(
      (m: Modality) => modalities.output.includes(m)
    );
    if (!hasAllOutputs) {
      exclusionReasons.set('output_modality_mismatch', (exclusionReasons.get('output_modality_mismatch') || 0) + 1);
      return false;
    }
  }

  // Check provider whitelist (dealbreaker if specified)
  if (constraints.providers && constraints.providers.length > 0) {
    const modelProvider = getProvider(model.id);
    const allowedProviders = constraints.providers.map(p => p.toLowerCase());
    if (!allowedProviders.includes(modelProvider)) {
      exclusionReasons.set('provider_not_allowed', (exclusionReasons.get('provider_not_allowed') || 0) + 1);
      return false;
    }
  }

  // Exclude free models (dealbreaker if specified)
  if (constraints.exclude_free && isFreeModel(model)) {
    exclusionReasons.set('free_model', (exclusionReasons.get('free_model') || 0) + 1);
    return false;
  }

  return true;
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

  const skeleton: RequestSkeleton = {
    model: modelIdToUse,
    messages: [],
    provider: {
      require_parameters: true,
      allow_fallbacks: true,
    },
  };

  if (routing === 'throughput') {
    skeleton.provider.sort = 'throughput';
  } else if (routing === 'latency') {
    skeleton.provider.sort = 'latency';
  } else {
    skeleton.provider.sort = 'price';
  }

  return skeleton;
}

function generateReasons(score: ScoreBreakdown, spec: TaskSpec): string[] {
  const reasons: string[] = [];

  if (score.semantic >= 0.7) reasons.push('high semantic match');
  if (score.parameters === 1) reasons.push('full param support');
  if (score.price >= 0.8) reasons.push('good price');
  if (score.context === 1 && spec.soft_constraints?.target_context_length) {
    reasons.push(`context>=${spec.soft_constraints.target_context_length / 1000}k`);
  }

  if (reasons.length === 0) {
    reasons.push(`score: ${score.total.toFixed(2)}`);
  }

  return reasons;
}

async function checkEndpoints(
  modelId: string,
  requiredParams: string[] | undefined,
  includeEndpoints: boolean
): Promise<{ summary?: EndpointsSummary; risk?: string }> {
  if (!includeEndpoints) {
    return {};
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

// ============================================================================
// Main Function
// ============================================================================

export async function task2model(spec: TaskSpec): Promise<Task2ModelOutcome> {
  const forceRefresh = spec.result?.force_refresh ?? false;
  const limit = spec.result?.limit ?? 50;
  const includeEndpoints = spec.result?.include_endpoints ?? false;
  const includeRequestSkeleton = spec.result?.include_request_skeleton ?? false;
  const detailLevel = spec.result?.detail ?? 'minimal';
  const useSemanticSearch = spec.preferences?.use_semantic_search ?? true;
  const weights = { ...DEFAULT_WEIGHTS, ...spec.preferences?.scoring_weights };
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

  // Step 1: Hard constraint filtering (true dealbreakers only)
  const filtered = allModels.filter(model =>
    meetsHardConstraints(model, spec.hard_constraints, exclusionReasons)
  );

  // Step 2: Ensure embeddings exist for filtered models
  if (useSemanticSearch && hasApiKey()) {
    await ensureEmbeddings(filtered);
  }

  // Step 3: Get task embedding for semantic scoring
  let taskEmbedding: number[] | null = null;
  if (useSemanticSearch && hasApiKey()) {
    const result = await getEmbeddings([spec.task]);
    if (result.ok && result.data.length > 0) {
      taskEmbedding = result.data[0];
    }
  }

  // Step 4: Score all models
  const scored = filtered.map(model => {
    let semanticScore = 0;
    if (taskEmbedding) {
      const modelEmbedding = getModelEmbedding(model.id);
      if (modelEmbedding) {
        const similarity = cosineSimilarity(taskEmbedding, modelEmbedding);
        semanticScore = (similarity + 1) / 2; // Normalize to 0-1
      }
    }

    const score = calculateScore(model, semanticScore, spec, weights);
    return { model, score };
  });

  // Step 5: Sort by total score (descending)
  scored.sort((a, b) => b.score.total - a.score.total);

  // Step 6: Take top N
  const shortlisted = scored.slice(0, limit);

  // Step 7: Build result based on detail level
  let shortlist: (ShortlistEntry | ShortlistEntryMinimal | OpenRouterModel)[];

  if (detailLevel === 'minimal') {
    shortlist = shortlisted.map(({ model, score }) => {
      const promptPrice = parseFloat(model.pricing.prompt || '0') * 1_000_000;
      const completionPrice = parseFloat(model.pricing.completion || '0') * 1_000_000;
      return {
        model_id: model.id,
        name: model.name,
        price: { prompt: promptPrice, completion: completionPrice },
        context: model.context_length,
        supports: model.supported_parameters || [],
        age_days: getModelAgeDays(model),
        score: score.total,
      };
    });
  } else if (detailLevel === 'full') {
    shortlist = shortlisted.map(({ model }) => model);
  } else {
    // Standard format
    shortlist = await Promise.all(
      shortlisted.map(async ({ model, score }) => {
        const modalities = parseModalities(model);
        const reasons = generateReasons(score, spec);
        const risks: string[] = [];

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
          score,
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
