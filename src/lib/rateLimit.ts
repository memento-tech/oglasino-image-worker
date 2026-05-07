// v1 stub. Per WORKER_PROMPT decision and contract §11.2/§11.3, the Worker
// ships without per-token / per-IP rate limiting in v1.
//
// Backend gates token issuance via Bucket4j (§11.4: 60 tokens/min/user) and
// upload JWTs are bound to a single key+content-type+maxBytes with a 10-min
// TTL, so leaked-token abuse is bounded.
//
// To add rate limiting later: replace this stub's body with a KV TTL counter
// or a Durable Object. The call sites in upload.ts / view.ts pass `jti` and
// `ip`; both are sufficient keying material.

import { ok, type Result, type WorkerError } from "../types.ts";

export type RateLimitKind = "upload-per-token" | "upload-per-ip" | "view-per-ip";

export interface RateLimitInput {
  kind: RateLimitKind;
  jti?: string | null;
  ip?: string | null;
}

export async function checkRateLimit(
  _input: RateLimitInput,
): Promise<Result<void, WorkerError>> {
  return ok(undefined);
}
