import { z } from 'zod';

// Modality types
const ModalitySchema = z.enum(['text', 'image', 'audio', 'video']);

// Hard constraints - TRUE dealbreakers only (binary pass/fail)
const HardConstraintsSchema = z.object({
  required_parameters: z.array(z.string()).optional(),  // Must support these (e.g., ["tools"])
  input_modalities: z.array(ModalitySchema).optional(), // Must support these inputs
  output_modalities: z.array(ModalitySchema).optional(),// Must support these outputs
  providers: z.array(z.string()).optional(),            // Must be from these providers
  exclude_free: z.boolean().optional(),                 // Exclude $0 models
  max_age_days: z.number().int().positive().default(365), // Max model age (default 1 year)
  max_price_per_1m: z.number().positive().optional(),   // Max $/1M tokens (prompt+completion)
}).strict();

// Preferences for sorting/routing
const PreferencesSchema = z.object({
  routing: z.enum(['price', 'throughput', 'latency']).default('price'),  // Secondary sort
  prefer_exacto_for_tools: z.boolean().default(true),
}).strict();

// Result configuration
const ResultConfigSchema = z.object({
  limit: z.number().int().positive().default(50),
  include_endpoints: z.boolean().default(false),
  include_parameters: z.boolean().default(false),
  include_request_skeleton: z.boolean().default(false),
  force_refresh: z.boolean().default(false),
  detail: z.enum(['names_only', 'minimal', 'standard', 'full']).default('names_only'),
}).strict();

// Main TaskSpec schema - simplified
export const TaskSpecSchema = z.object({
  task: z.string().min(1, 'Task description is required'),  // Main ranking via embedding
  hard_constraints: HardConstraintsSchema.optional(),        // Dealbreakers only
  preferences: PreferencesSchema.optional(),                 // Secondary sort
  result: ResultConfigSchema.optional(),
}).strict();

export type TaskSpec = z.infer<typeof TaskSpecSchema>;
export type HardConstraints = z.infer<typeof HardConstraintsSchema>;
export type Preferences = z.infer<typeof PreferencesSchema>;
export type ResultConfig = z.infer<typeof ResultConfigSchema>;
export type Modality = z.infer<typeof ModalitySchema>;

// OpenRouter model structure (from /api/v1/models)
export interface OpenRouterModel {
  id: string;
  name: string;
  created?: number;
  description?: string;
  context_length: number;
  architecture?: {
    modality?: string;
    tokenizer?: string;
    instruct_type?: string;
  };
  pricing: {
    prompt: string;
    completion: string;
    request?: string;
    image?: string;
  };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
    is_moderated?: boolean;
  };
  per_request_limits?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  supported_parameters?: string[];
}

// OpenRouter endpoint structure (from /api/v1/models/:author/:slug/endpoints)
export interface OpenRouterEndpoint {
  name: string;
  context_length?: number;
  max_completion_tokens?: number;
  pricing?: {
    prompt: string;
    completion: string;
    request?: string;
  };
  supported_parameters?: string[];
  provider_name?: string;
  quantization?: string;
}

// Result types - minimal format (detail: "minimal")
export interface ShortlistEntryMinimal {
  model_id: string;
  name: string;
  price: { prompt: number; completion: number };  // Per 1M tokens
  context: number;
  supports: string[];
  age_days: number;
  semantic_score: number;  // Embedding similarity (0-1)
}

// Result types - standard format (detail: "standard")
export interface ShortlistEntry {
  model_id: string;
  name?: string;
  created?: number;
  context_length?: number;
  age_days?: number;
  pricing?: {
    prompt: string;
    completion: string;
    request?: string;
  };
  modalities?: {
    input?: string[];
    output?: string[];
  };
  supported_parameters?: string[];
  semantic_score: number;  // Embedding similarity (0-1)
  why_selected: string[];
  request_skeleton?: RequestSkeleton;
  endpoints_summary?: EndpointsSummary;
}

export interface RequestSkeleton {
  model: string;
  messages: unknown[];
  provider: {
    require_parameters: boolean;
    allow_fallbacks: boolean;
    sort?: string;
  };
}

export interface EndpointsSummary {
  count: number;
  endpoints: Array<{
    name: string;
    supports_required_params: boolean;
    context_length?: number;
  }>;
}

export interface ExcludedSummary {
  total_models: number;
  after_hard_filter: number;
  excluded_by: Record<string, number>;
}

export interface CatalogInfo {
  fetched_at: string;
  cache_age_ms: number;
  source: 'live' | 'cache';
  auth_used: boolean;
}

export interface EmbeddingStatus {
  enabled: boolean;
  api_key_status: string;  // masked key info for debugging
  task_embedded: boolean;
  models_embedded: number;
  models_failed: number;
  error?: string;
}

// Result for names_only mode - ultra compact
export interface Task2ModelResultNamesOnly {
  task: string;
  models: string[];  // Just model IDs
  count: number;
  price_range: string;  // e.g., "$0.10-$15.00/1M"
}

// Result for other modes
export interface Task2ModelResultFull {
  task: string;
  shortlist: (ShortlistEntry | ShortlistEntryMinimal | OpenRouterModel)[];
  excluded_summary: ExcludedSummary;
  catalog: CatalogInfo;
  embeddings: EmbeddingStatus;
}

export type Task2ModelResult = Task2ModelResultNamesOnly | Task2ModelResultFull;

// Sync catalog result
export interface SyncCatalogResult {
  model_count: number;
  fetched_at: string;
  source: 'live' | 'cache';
  auth_used: boolean;
}

// Get model profile result
export interface ModelProfileResult {
  model: OpenRouterModel;
  endpoints?: OpenRouterEndpoint[];
  parameters?: Record<string, unknown>;
  fetched_at: string;
  auth_used: boolean;
}
