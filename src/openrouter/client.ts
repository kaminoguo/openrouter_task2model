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

export type ClientResult<T> =
  | { ok: true; data: T; auth_used: boolean }
  | { ok: false; error: StructuredError };

function getApiKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY;
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
