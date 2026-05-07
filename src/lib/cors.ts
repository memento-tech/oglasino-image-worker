// CORS per contract §9. No `*`. Vercel previews matched by suffix. Vary: Origin
// on every CORS-affected response.

import type { Env } from "../types.ts";

const ALLOWED_METHODS = "GET, PUT, POST, OPTIONS, HEAD";
const ALLOWED_REQUEST_HEADERS = "Content-Type, x-upload-token, Authorization, x-request-id";
const EXPOSED_RESPONSE_HEADERS = "Content-Type, Content-Length, ETag, Retry-After, x-request-id";
const PREFLIGHT_MAX_AGE = "86400";

const VERCEL_PREVIEW_PREFIX = "https://oglasino-web-";
const VERCEL_PREVIEW_SUFFIX = ".vercel.app";

export function isOriginAllowed(origin: string | null, env: Env): boolean {
  if (origin === null || origin === "") return false;

  // Exact-match list from env.
  const list = env.ALLOWED_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  if (list.includes(origin)) return true;

  // Vercel preview wildcard (§9.1).
  if (
    origin.startsWith(VERCEL_PREVIEW_PREFIX) &&
    origin.endsWith(VERCEL_PREVIEW_SUFFIX)
  ) {
    // Reject if there's anything between scheme/prefix and suffix that would
    // let an attacker register e.g. `oglasino-web-attacker.vercel.app.evil.com`.
    // Browsers won't send such an origin, but be defensive.
    const middle = origin.slice(
      VERCEL_PREVIEW_PREFIX.length,
      origin.length - VERCEL_PREVIEW_SUFFIX.length,
    );
    return middle.length > 0 && /^[A-Za-z0-9-]+$/.test(middle);
  }

  return false;
}

// Returns the CORS headers to attach to a response. Always includes Vary:
// Origin so caches don't leak responses across origins. If the request had
// no Origin header (server-to-server, RN), we don't echo Allow-Origin.
export function corsHeaders(
  request: Request,
  env: Env,
  requestId: string,
): Headers {
  const headers = new Headers();
  headers.set("Vary", "Origin");
  headers.set("x-request-id", requestId);

  const origin = request.headers.get("Origin");
  if (origin !== null && isOriginAllowed(origin, env)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Expose-Headers", EXPOSED_RESPONSE_HEADERS);
    // Allow-Credentials stays false (§9.4): omit the header entirely.
  }

  return headers;
}

export function buildPreflightResponse(
  request: Request,
  env: Env,
  requestId: string,
): Response {
  const headers = corsHeaders(request, env, requestId);
  // Browsers only act on these if Allow-Origin is set; setting them
  // unconditionally is harmless and makes debugging easier.
  headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
  headers.set("Access-Control-Allow-Headers", ALLOWED_REQUEST_HEADERS);
  headers.set("Access-Control-Max-Age", PREFLIGHT_MAX_AGE);
  return new Response(null, { status: 204, headers });
}
