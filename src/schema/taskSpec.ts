import { z } from 'zod';

// Modality types
const ModalitySchema = z.enum(['text', 'image', 'audio', 'video']);

// Max price constraints
const MaxPriceSchema = z.object({
  prompt_per_1m: z.number().optional(),
  completion_per_1m: z.number().optional(),
  request: z.number().optional(),
}).strict();

// Hard constraints for filtering
const HardConstraintsSchema = z.object({
  min_context_length: z.number().int().positive().optional(),
  input_modalities: z.array(ModalitySchema).optional(),
  output_modalities: z.array(ModalitySchema).optional(),
  required_parameters: z.array(z.string()).optional(),
  max_price: MaxPriceSchema.optional(),
  // New filters for quality/reliability
  min_age_days: z.number().int().nonnegative().optional(),  // Exclude models < N days old
  exclude_free: z.boolean().optional(),                      // Skip $0 pricing models
  providers: z.array(z.string()).optional(),                 // Whitelist providers e.g. ["anthropic", "openai"]
}).strict();

// Preferences for sorting/routing
const PreferencesSchema = z.object({
  prefer_newer: z.boolean().default(true),
  routing: z.enum(['price', 'throughput', 'latency']).default('price'),
  prefer_exacto_for_tools: z.boolean().default(true),
  top_provider_only: z.boolean().default(false),
}).strict();

// Result configuration
const ResultConfigSchema = z.object({
  limit: z.number().int().positive().default(50),  // Default higher for initial scan
  include_endpoints: z.boolean().default(false),
  include_parameters: z.boolean().default(false),
  include_request_skeleton: z.boolean().default(false),  // Off by default for minimal scans
  force_refresh: z.boolean().default(false),
  detail: z.enum(['minimal', 'standard', 'full']).default('minimal'),  // Start with minimal scan
}).strict();

// Main TaskSpec schema
export const TaskSpecSchema = z.object({
  task: z.string().min(1, 'Task description is required'),
  hard_constraints: HardConstraintsSchema.optional(),
  preferences: PreferencesSchema.optional(),
  result: ResultConfigSchema.optional(),
}).strict();

export type TaskSpec = z.infer<typeof TaskSpecSchema>;
export type HardConstraints = z.infer<typeof HardConstraintsSchema>;
export type Preferences = z.infer<typeof PreferencesSchema>;
export type ResultConfig = z.infer<typeof ResultConfigSchema>;
export type MaxPrice = z.infer<typeof MaxPriceSchema>;
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
}

// Result types - standard format (detail: "standard", default)
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
  why_selected: string[];
  risks?: string[];
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

export interface Task2ModelResult {
  task: string;
  shortlist: (ShortlistEntry | ShortlistEntryMinimal | OpenRouterModel)[];
  excluded_summary: ExcludedSummary;
  catalog: CatalogInfo;
}

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
