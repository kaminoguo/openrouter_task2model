import type { OpenRouterModel, OpenRouterEndpoint } from '../schema/taskSpec.js';
import { authRequired, networkError, upstreamError, type StructuredError } from '../util/errors.js';

const BASE_URL = 'https://openrouter.ai/api/v1';

export interface ModelsResponse {
  data: OpenRouterModel[];
}

export interface EndpointsResponse {
  data: {
    endpoints: OpenRouterEndpoint[];
  };
}

export interface ParametersResponse {
  data: {
    supported_parameters: string[];
    [key: string]: unknown;
  };
}

export interface EmbeddingData {
  object: string;
  embedding: number[];
  index: number;
}

export interface EmbeddingResponse {
  object: string;
  data: EmbeddingData[];
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

// Default embedding model - best quality/price ratio on MTEB
const DEFAULT_EMBEDDING_MODEL = 'qwen/qwen3-embedding-8b';

export type ClientResult<T> =
  | { ok: true; data: T; auth_used: boolean }
  | { ok: false; error: StructuredError };

function getApiKey(): string | undefined {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) return undefined;
  // Only reject obvious placeholder values
  if (key === 'sk-or-...' || key === 'sk-or-xxx' || key.length < 10) {
    return undefined;
  }
  return key;
}

function getHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://github.com/openrouter-task2model',
    'X-Title': 'openrouter-task2model',
  };

  const apiKey = getApiKey();
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  return headers;
}

async function fetchWithErrorHandling<T>(
  url: string,
  requiresAuth = false
): Promise<ClientResult<T>> {
  const auth_used = !!getApiKey();

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: getHeaders(),
    });

    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: authRequired('Authentication required for this endpoint') };
    }

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text();
      }
      return {
        ok: false,
        error: upstreamError(
          `OpenRouter API returned status ${response.status}`,
          response.status,
          body
        ),
      };
    }

    const data = await response.json() as T;
    return { ok: true, data, auth_used };
  } catch (err) {
    if (requiresAuth && !auth_used) {
      return { ok: false, error: authRequired() };
    }
    return {
      ok: false,
      error: networkError('Failed to connect to OpenRouter API', err),
    };
  }
}

export async function getModels(): Promise<ClientResult<OpenRouterModel[]>> {
  const result = await fetchWithErrorHandling<ModelsResponse>(`${BASE_URL}/models`);
  if (!result.ok) return result;
  return { ok: true, data: result.data.data, auth_used: result.auth_used };
}

export async function getEndpoints(modelId: string): Promise<ClientResult<OpenRouterEndpoint[]>> {
  // modelId format: "author/slug" or "author/slug:variant"
  // We need just "author/slug" for the endpoint
  const baseModelId = modelId.split(':')[0];
  const url = `${BASE_URL}/models/${baseModelId}/endpoints`;

  const result = await fetchWithErrorHandling<EndpointsResponse>(url, true);
  if (!result.ok) return result;

  return { ok: true, data: result.data.data?.endpoints || [], auth_used: result.auth_used };
}

export async function getParameters(modelId: string): Promise<ClientResult<Record<string, unknown>>> {
  // modelId format: "author/slug" or "author/slug:variant"
  const baseModelId = modelId.split(':')[0];
  const url = `${BASE_URL}/parameters/${baseModelId}`;

  const result = await fetchWithErrorHandling<ParametersResponse>(url, true);
  if (!result.ok) return result;

  return { ok: true, data: result.data.data, auth_used: result.auth_used };
}

export function hasApiKey(): boolean {
  return !!getApiKey();
}

// Get API key status for debugging (masked)
export function getApiKeyStatus(): { valid: boolean; format: string } {
  const raw = process.env.OPENROUTER_API_KEY?.trim();
  if (!raw) {
    return { valid: false, format: 'not set' };
  }
  if (raw === 'sk-or-...' || raw === 'sk-or-xxx') {
    return { valid: false, format: 'placeholder value' };
  }
  if (raw.length < 10) {
    return { valid: false, format: `too short (${raw.length} chars)` };
  }
  // Mask key for display: show first 4 and last 4 chars
  const masked = `${raw.slice(0, 4)}***${raw.slice(-4)}`;
  return { valid: true, format: `${masked} (${raw.length} chars)` };
}

// Get embeddings for a list of texts
export async function getEmbeddings(
  texts: string[],
  model: string = DEFAULT_EMBEDDING_MODEL
): Promise<ClientResult<number[][]>> {
  if (!hasApiKey()) {
    return { ok: false, error: authRequired('API key required for embeddings') };
  }

  if (texts.length === 0) {
    return { ok: true, data: [], auth_used: true };
  }

  try {
    const response = await fetch(`${BASE_URL}/embeddings`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        model,
        input: texts,
      }),
    });

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text();
      }

      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          error: authRequired(`Embeddings auth failed (${response.status}): ${JSON.stringify(body)}`)
        };
      }

      return {
        ok: false,
        error: upstreamError(
          `OpenRouter Embeddings API returned status ${response.status}`,
          response.status,
          body
        ),
      };
    }

    const data = await response.json() as EmbeddingResponse;
    // Sort by index to ensure order matches input
    const sorted = data.data.sort((a, b) => a.index - b.index);
    return { ok: true, data: sorted.map(d => d.embedding), auth_used: true };
  } catch (err) {
    return {
      ok: false,
      error: networkError('Failed to connect to OpenRouter Embeddings API', err),
    };
  }
}

// Compute cosine similarity between two vectors
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}
