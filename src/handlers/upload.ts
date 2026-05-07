// PUT /{key} — upload. Contract §4.1. Validation order is exactly the
// 10-step list in the contract; each step returns Result<T, WorkerError> and
// we fail fast on the first error.

import { verifyUploadJwt } from "../auth/jwt.ts";
import { corsHeaders } from "../lib/cors.ts";
import { buildErrorResponse, makeError } from "../lib/errors.ts";
import { log, truncateUa } from "../lib/logger.ts";
import { validateKey } from "../lib/pathValidation.ts";
import { checkRateLimit } from "../lib/rateLimit.ts";
import {
  err,
  ok,
  type Env,
  type Result,
  type UploadJwtClaims,
  type WorkerError,
} from "../types.ts";

const OP = "upload";

interface ParsedHeaders {
  token: string;
  contentType: string;
  contentLength: number;
}

function parseHeaders(request: Request): Result<ParsedHeaders, WorkerError> {
  const token = request.headers.get("x-upload-token");
  if (token === null || token.length === 0) {
    return err(makeError("TOKEN_MISSING", "x-upload-token header is required"));
  }

  const contentType = request.headers.get("Content-Type");
  if (contentType === null || contentType.length === 0) {
    return err(
      makeError("CONTENT_TYPE_NOT_ALLOWED", "Content-Type header is required"),
    );
  }

  const rawLen = request.headers.get("Content-Length");
  if (rawLen === null) {
    return err(
      makeError("FILE_TOO_LARGE", "Content-Length header is required", {
        reason: "missing",
      }),
    );
  }
  const contentLength = Number.parseInt(rawLen, 10);
  if (!Number.isFinite(contentLength) || contentLength < 0) {
    return err(
      makeError("FILE_TOO_LARGE", "Content-Length is not a valid integer", {
        received: rawLen,
      }),
    );
  }

  return ok({ token, contentType, contentLength });
}

function parseEnvMaxBytes(env: Env): number {
  const n = Number.parseInt(env.MAX_UPLOAD_BYTES, 10);
  // Defensive default. Any production deploy sets this explicitly via
  // wrangler.toml [vars]; the fallback is just so dev/tests don't crash.
  return Number.isFinite(n) && n > 0 ? n : 10 * 1024 * 1024;
}

function parseAllowedContentTypes(env: Env): readonly string[] {
  return env.ALLOWED_CONTENT_TYPES.split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

export async function handleUpload(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  const baseHeaders = corsHeaders(request, env, requestId);
  const url = new URL(request.url);
  const ip = request.headers.get("CF-Connecting-IP");
  const ua = truncateUa(request.headers.get("User-Agent"));

  const fail = (e: WorkerError, claims?: UploadJwtClaims | null): Response => {
    log(levelFor(e.code), {
      op: OP,
      code: e.code,
      requestId,
      userId: claims?.sub ?? null,
      tokenJti: claims?.jti ?? null,
      key: claims?.key ?? url.pathname.slice(1),
      bytes: null,
      contentType: claims?.contentType ?? null,
      ip,
      ua,
    });
    return buildErrorResponse(e, baseHeaders);
  };

  // Step 1: path traversal.
  const keyResult = validateKey(url.pathname);
  if (!keyResult.ok) return fail(keyResult.error);
  const key = keyResult.value;

  // Step 2: header presence.
  const headersResult = parseHeaders(request);
  if (!headersResult.ok) return fail(headersResult.error);
  const { token, contentType, contentLength } = headersResult.value;

  // Steps 3, 4, 5: JWT verify (signature, exp, iss, scope).
  const jwtResult = await verifyUploadJwt(token, env);
  if (!jwtResult.ok) return fail(jwtResult.error);
  const claims = jwtResult.value;

  // Per-token rate limit (§11.2). Stub in v1 — see lib/rateLimit.ts.
  const rl = await checkRateLimit({
    kind: "upload-per-token",
    jti: claims.jti,
    ip,
  });
  if (!rl.ok) return fail(rl.error, claims);

  // Step 6: JWT key matches request path exactly.
  if (claims.key !== key) {
    return fail(
      makeError("TOKEN_KEY_MISMATCH", "Token key does not match request path", {
        tokenKey: claims.key,
        requestKey: key,
      }),
      claims,
    );
  }

  // Step 7: JWT contentType matches request Content-Type.
  if (claims.contentType.toLowerCase() !== contentType.toLowerCase()) {
    return fail(
      makeError("CONTENT_TYPE_MISMATCH", "Content-Type does not match token", {
        tokenContentType: claims.contentType,
        requestContentType: contentType,
      }),
      claims,
    );
  }

  // Step 8: Content-Length ≤ min(JWT maxBytes, env MAX_UPLOAD_BYTES).
  const envMax = parseEnvMaxBytes(env);
  const cap = Math.min(claims.maxBytes, envMax);
  if (contentLength > cap) {
    return fail(
      makeError(
        "FILE_TOO_LARGE",
        `Upload exceeds ${cap} bytes (received ${contentLength} bytes)`,
        { max: cap, received: contentLength },
      ),
      claims,
    );
  }

  // Step 9: Content-Type in env allowlist.
  const allowed = parseAllowedContentTypes(env);
  if (!allowed.includes(contentType.toLowerCase())) {
    return fail(
      makeError(
        "CONTENT_TYPE_NOT_ALLOWED",
        `Content-Type ${contentType} is not in the allowlist`,
        { received: contentType, allowed },
      ),
      claims,
    );
  }

  // Step 10: idempotent retry. R2 head; if same content-type and size,
  // return success without rewriting (§4.1, §10.3 "Token already consumed").
  let existing: R2Object | null = null;
  try {
    existing = await env.BUCKET.head(key);
  } catch {
    // Head failure isn't fatal — proceed with the write.
    existing = null;
  }
  if (
    existing !== null &&
    existing.httpMetadata?.contentType === contentType &&
    existing.size === contentLength
  ) {
    log("INFO", {
      op: OP,
      code: "OK_IDEMPOTENT",
      requestId,
      userId: claims.sub,
      tokenJti: claims.jti,
      key,
      bytes: existing.size,
      contentType,
      ip,
      ua,
    });
    return successResponse(
      { key, bytes: existing.size, contentType },
      baseHeaders,
    );
  }
  if (existing !== null) {
    // Object exists but doesn't match — this is the "conflict" case from
    // §10.3. We log WARN and proceed to overwrite (R2 PUT is overwrite-
    // by-default). The contract permits this.
    log("WARN", {
      op: OP,
      code: "OK_OVERWRITE_CONFLICT",
      requestId,
      userId: claims.sub,
      tokenJti: claims.jti,
      key,
      bytes: contentLength,
      contentType,
      ip,
      ua,
      extra: {
        existingContentType: existing.httpMetadata?.contentType ?? null,
        existingSize: existing.size,
      },
    });
  }

  // Step 11: stream bytes to R2.
  if (request.body === null) {
    return fail(
      makeError("FILE_TOO_LARGE", "Request body is empty", {
        reason: "no-body",
      }),
      claims,
    );
  }
  try {
    await env.BUCKET.put(key, request.body, {
      httpMetadata: { contentType },
    });
  } catch (e) {
    return fail(
      makeError("R2_WRITE_FAILED", "R2 put failed", {
        cause: e instanceof Error ? e.message : String(e),
      }),
      claims,
    );
  }

  // Step 12: success.
  log("INFO", {
    op: OP,
    code: "OK",
    requestId,
    userId: claims.sub,
    tokenJti: claims.jti,
    key,
    bytes: contentLength,
    contentType,
    ip,
    ua,
  });
  return successResponse({ key, bytes: contentLength, contentType }, baseHeaders);
}

function successResponse(
  body: { key: string; bytes: number; contentType: string },
  baseHeaders: Headers,
): Response {
  const headers = new Headers(baseHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status: 200, headers });
}

// Log levels per §10.3.
function levelFor(code: string): "INFO" | "WARN" | "ERROR" {
  switch (code) {
    case "TOKEN_SIGNATURE_INVALID":
    case "TOKEN_SCOPE_MISMATCH":
    case "TOKEN_KEY_MISMATCH":
    case "PATH_TRAVERSAL":
    case "BACKEND_AUTH_MISSING":
    case "BACKEND_AUTH_INVALID":
      return "WARN";
    case "R2_WRITE_FAILED":
    case "R2_READ_FAILED":
    case "INTERNAL":
      return "ERROR";
    default:
      // TOKEN_MISSING/MALFORMED/EXPIRED/ISSUER_INVALID,
      // CONTENT_TYPE_*, FILE_TOO_LARGE, RATE_LIMITED, OBJECT_NOT_FOUND
      return "INFO";
  }
}
