// Error response builder. Contract §8 (JSON shape, code catalog, headers).

import type { WorkerError, WorkerErrorCode } from "../types.ts";

interface ErrorDefaults {
  status: number;
  retryable: boolean;
}

const DEFAULTS: Record<WorkerErrorCode, ErrorDefaults> = {
  TOKEN_MISSING: { status: 400, retryable: false },
  TOKEN_MALFORMED: { status: 400, retryable: false },
  TOKEN_EXPIRED: { status: 401, retryable: false },
  TOKEN_SIGNATURE_INVALID: { status: 401, retryable: false },
  TOKEN_ISSUER_INVALID: { status: 401, retryable: false },
  TOKEN_SCOPE_MISMATCH: { status: 403, retryable: false },
  TOKEN_KEY_MISMATCH: { status: 403, retryable: false },
  CONTENT_TYPE_NOT_ALLOWED: { status: 415, retryable: false },
  CONTENT_TYPE_MISMATCH: { status: 415, retryable: false },
  FILE_TOO_LARGE: { status: 413, retryable: false },
  PATH_TRAVERSAL: { status: 400, retryable: false },
  RATE_LIMITED: { status: 429, retryable: true },
  OBJECT_NOT_FOUND: { status: 404, retryable: false },
  R2_WRITE_FAILED: { status: 500, retryable: true },
  R2_READ_FAILED: { status: 500, retryable: true },
  BACKEND_AUTH_MISSING: { status: 401, retryable: false },
  BACKEND_AUTH_INVALID: { status: 401, retryable: false },
  INTERNAL: { status: 500, retryable: false },
  METHOD_NOT_ALLOWED: { status: 405, retryable: false },
};

export function makeError(
  code: WorkerErrorCode,
  message: string,
  details?: Record<string, unknown>,
): WorkerError {
  const defaults = DEFAULTS[code];
  return {
    code,
    status: defaults.status,
    message,
    retryable: defaults.retryable,
    ...(details !== undefined ? { details } : {}),
  };
}

export function buildErrorResponse(
  error: WorkerError,
  baseHeaders: HeadersInit,
): Response {
  const body = JSON.stringify({
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
      retryable: error.retryable,
    },
  });
  const headers = new Headers(baseHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(body, { status: error.status, headers });
}
