// GET /{key} — public + private. Contract §4.2.
//   - public/* : no auth, long-cached
//   - private/*: ?token=<view-jwt>, short-cached, validates keyPrefix
//   - other    : 404 (per §4.2 "Other paths → 404")

import { verifyViewJwt } from "../auth/jwt.ts";
import { corsHeaders } from "../lib/cors.ts";
import { buildErrorResponse, makeError } from "../lib/errors.ts";
import { log, truncateUa } from "../lib/logger.ts";
import { getKeyVisibility, validateKey } from "../lib/pathValidation.ts";
import {
  type Env,
  type ViewJwtClaims,
  type WorkerError,
} from "../types.ts";

const OP = "view";

export async function handleView(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  return await respond(request, env, requestId, /* withBody */ true);
}

export async function handleHead(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  return await respond(request, env, requestId, /* withBody */ false);
}

async function respond(
  request: Request,
  env: Env,
  requestId: string,
  withBody: boolean,
): Promise<Response> {
  const baseHeaders = corsHeaders(request, env, requestId);
  const url = new URL(request.url);
  const ip = request.headers.get("CF-Connecting-IP");
  const ua = truncateUa(request.headers.get("User-Agent"));

  const fail = (e: WorkerError, claims?: ViewJwtClaims | null, key?: string | null) => {
    log(levelFor(e.code), {
      op: OP,
      code: e.code,
      requestId,
      userId: claims?.sub ?? null,
      tokenJti: claims?.jti ?? null,
      key: key ?? null,
      chatId: claims?.chatId ?? null,
      ip,
      ua,
    });
    return buildErrorResponse(e, baseHeaders);
  };

  const keyResult = validateKey(url.pathname);
  if (!keyResult.ok) return fail(keyResult.error);
  const key = keyResult.value;

  const visibility = getKeyVisibility(key);
  if (visibility === "other") {
    // §4.2: other paths → 404 OBJECT_NOT_FOUND.
    return fail(
      makeError("OBJECT_NOT_FOUND", "No handler for this path", {
        prefix: key.split("/")[0] ?? "",
      }),
      null,
      key,
    );
  }

  let claims: ViewJwtClaims | null = null;

  if (visibility === "private") {
    const token = url.searchParams.get("token");
    if (token === null || token.length === 0) {
      return fail(
        makeError("TOKEN_MISSING", "?token query parameter is required"),
        null,
        key,
      );
    }
    const v = await verifyViewJwt(token, env);
    if (!v.ok) return fail(v.error, null, key);
    claims = v.value;

    // §4.2 step 6: requested key must start with JWT keyPrefix.
    if (!key.startsWith(claims.keyPrefix)) {
      return fail(
        makeError("TOKEN_KEY_MISMATCH", "Requested key not under token keyPrefix", {
          keyPrefix: claims.keyPrefix,
          requestKey: key,
        }),
        claims,
        key,
      );
    }
  }

  // R2 fetch.
  try {
    const obj = withBody
      ? await env.BUCKET.get(key)
      : await env.BUCKET.head(key);
    if (obj === null) {
      return fail(
        makeError("OBJECT_NOT_FOUND", "R2 has no object for this key"),
        claims,
        key,
      );
    }
    return buildBytesResponse(obj, withBody, visibility, baseHeaders, key, claims, requestId, ip, ua);
  } catch (e) {
    return fail(
      makeError("R2_READ_FAILED", "R2 get/head failed", {
        cause: e instanceof Error ? e.message : String(e),
      }),
      claims,
      key,
    );
  }
}

function buildBytesResponse(
  obj: R2Object | R2ObjectBody,
  withBody: boolean,
  visibility: "public" | "private",
  baseHeaders: Headers,
  key: string,
  claims: ViewJwtClaims | null,
  requestId: string,
  ip: string | null,
  ua: string | null,
): Response {
  const headers = new Headers(baseHeaders);
  const contentType = obj.httpMetadata?.contentType ?? "application/octet-stream";
  headers.set("Content-Type", contentType);
  headers.set("Content-Length", String(obj.size));
  if (obj.etag) headers.set("ETag", obj.etag);

  if (visibility === "public") {
    // §4.2 public flow: long cache, immutable, with Vary: Accept so the
    // downstream Image Resizing layer can negotiate format.
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    appendVary(headers, "Accept");
  } else {
    // §4.2 private flow: token-bound, short private cache.
    headers.set("Cache-Control", "private, max-age=300");
  }

  // §10.3: only private GETs are logged at INFO; public GETs are too noisy.
  if (visibility === "private") {
    log("INFO", {
      op: OP,
      code: "OK",
      requestId,
      userId: claims?.sub ?? null,
      tokenJti: claims?.jti ?? null,
      key,
      chatId: claims?.chatId ?? null,
      bytes: obj.size,
      contentType,
      ip,
      ua,
    });
  }

  if (withBody && "body" in obj) {
    return new Response(obj.body, { status: 200, headers });
  }
  return new Response(null, { status: 200, headers });
}

function appendVary(headers: Headers, value: string): void {
  const existing = headers.get("Vary");
  if (existing === null || existing.length === 0) {
    headers.set("Vary", value);
    return;
  }
  // Avoid duplicates.
  const parts = existing.split(",").map((s) => s.trim().toLowerCase());
  if (!parts.includes(value.toLowerCase())) {
    headers.set("Vary", `${existing}, ${value}`);
  }
}

function levelFor(code: string): "INFO" | "WARN" | "ERROR" {
  switch (code) {
    case "TOKEN_SIGNATURE_INVALID":
    case "TOKEN_SCOPE_MISMATCH":
    case "TOKEN_KEY_MISMATCH":
    case "PATH_TRAVERSAL":
      return "WARN";
    case "R2_READ_FAILED":
    case "INTERNAL":
      return "ERROR";
    default:
      return "INFO";
  }
}
