// Shared types. Contract reference: §4 (endpoints), §5 (JWT claims),
// §8 (error codes), §10 (logging), §12 (env vars).

export interface Env {
  BUCKET: R2Bucket;

  // Secrets — set via `wrangler secret put`. Required at runtime.
  JWT_SIGNING_SECRET: string;
  BACKEND_SHARED_SECRET: string;

  // Optional during a key-rotation window (§5.6, §2.3).
  JWT_SIGNING_SECRET_PREVIOUS?: string;

  // Vars — set in wrangler.toml.
  ALLOWED_ORIGINS: string;
  ALLOWED_CONTENT_TYPES: string;
  MAX_UPLOAD_BYTES: string;
  UPLOAD_TOKEN_TTL_MS: string;
  VIEW_TOKEN_TTL_MS: string;
  ENVIRONMENT: string;
}

// Result<T, E> — every async validation step returns this so we never
// throw across module boundaries. Top-level handler catches the unexpected.
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

// Worker error codes (§8.2). Keep in sync with that table.
export type WorkerErrorCode =
  | "TOKEN_MISSING"
  | "TOKEN_MALFORMED"
  | "TOKEN_EXPIRED"
  | "TOKEN_SIGNATURE_INVALID"
  | "TOKEN_ISSUER_INVALID"
  | "TOKEN_SCOPE_MISMATCH"
  | "TOKEN_KEY_MISMATCH"
  | "CONTENT_TYPE_NOT_ALLOWED"
  | "CONTENT_TYPE_MISMATCH"
  | "FILE_TOO_LARGE"
  | "PATH_TRAVERSAL"
  | "RATE_LIMITED"
  | "OBJECT_NOT_FOUND"
  | "R2_WRITE_FAILED"
  | "R2_READ_FAILED"
  | "BACKEND_AUTH_MISSING"
  | "BACKEND_AUTH_INVALID"
  | "INTERNAL"
  | "METHOD_NOT_ALLOWED";

export interface WorkerError {
  readonly code: WorkerErrorCode;
  readonly status: number;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;
}

// JWT claims (§5.1, §5.2). Worker only verifies; backend signs.
export interface BaseJwtClaims {
  iss: string;
  iat: number;
  exp: number;
  jti: string;
  sub: string;
  scope: string;
}

export interface UploadJwtClaims extends BaseJwtClaims {
  scope: "upload";
  kind: "product" | "profile" | "chat" | "report";
  key: string;
  contentType: string;
  maxBytes: number;
}

export interface ViewJwtClaims extends BaseJwtClaims {
  scope: "view";
  kind: "chat";
  keyPrefix: string;
  chatId: string;
}

// Logging shape (§10.2). Required: ts, level, op, code, requestId.
export type LogLevel = "INFO" | "WARN" | "ERROR";

export interface LogFields {
  op: string;
  code: string;
  requestId: string;
  userId?: string | null;
  tokenJti?: string | null;
  key?: string | null;
  chatId?: string | null;
  bytes?: number | null;
  contentType?: string | null;
  ip?: string | null;
  ua?: string | null;
  extra?: Record<string, unknown>;
}

export const ISSUER = "oglasino-backend";
