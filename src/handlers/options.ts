// CORS preflight (§9, §4.3). Worker echoes Allow-Origin only when the origin
// is in the allowlist; otherwise the response carries no Allow-Origin and the
// browser blocks the actual request — which is what we want.

import type { Env } from "../types.ts";
import { buildPreflightResponse } from "../lib/cors.ts";

export function handleOptions(
  request: Request,
  env: Env,
  requestId: string,
): Response {
  return buildPreflightResponse(request, env, requestId);
}
