// Backend → Worker admin auth via X-Backend-Auth header (§2.2). Constant-time
// compare against BACKEND_SHARED_SECRET. Unused in v1 (no admin endpoints,
// §3.4) but kept to avoid surprises when admin endpoints get added.

import { err, ok, type Env, type Result, type WorkerError } from "../types.ts";
import { makeError } from "../lib/errors.ts";

const HEADER = "X-Backend-Auth";

export function verifyAdminAuth(
  request: Request,
  env: Env,
): Result<void, WorkerError> {
  const supplied = request.headers.get(HEADER);
  if (supplied === null || supplied.length === 0) {
    return err(makeError("BACKEND_AUTH_MISSING", "X-Backend-Auth header missing"));
  }
  if (!timingSafeEqual(supplied, env.BACKEND_SHARED_SECRET)) {
    return err(makeError("BACKEND_AUTH_INVALID", "X-Backend-Auth value rejected"));
  }
  return ok(undefined);
}

// Constant-time string compare. Length is not secret (server-controlled
// secret has fixed length) so an early-return on length mismatch is fine.
export function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}
