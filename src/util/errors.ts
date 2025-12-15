export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'NETWORK_ERROR'
  | 'UPSTREAM_ERROR'
  | 'INVALID_INPUT';

export interface StructuredError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export function createError(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>
): StructuredError {
  return { code, message, details };
}

export function authRequired(message = 'API key required for this operation'): StructuredError {
  return createError('AUTH_REQUIRED', message, {
    hint: 'Set OPENROUTER_API_KEY environment variable'
  });
}

export function networkError(message: string, cause?: unknown): StructuredError {
  return createError('NETWORK_ERROR', message, {
    cause: cause instanceof Error ? cause.message : String(cause)
  });
}

export function upstreamError(message: string, status?: number, body?: unknown): StructuredError {
  return createError('UPSTREAM_ERROR', message, { status, body });
}

export function invalidInput(message: string, field?: string): StructuredError {
  return createError('INVALID_INPUT', message, { field });
}

export function isStructuredError(value: unknown): value is StructuredError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'message' in value
  );
}
