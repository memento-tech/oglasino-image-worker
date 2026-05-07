// Worker entry point. Routes by method per contract §4. Catches any
// unexpected throw at the top level and returns a generic INTERNAL error.

import { handleHead } from "./handlers/head.ts";
import { handleOptions } from "./handlers/options.ts";
import { handleUpload } from "./handlers/upload.ts";
import { handleView } from "./handlers/view.ts";
import { corsHeaders } from "./lib/cors.ts";
import { buildErrorResponse, makeError } from "./lib/errors.ts";
import { log, truncateUa } from "./lib/logger.ts";
import { extractOrCreateRequestId } from "./lib/requestId.ts";
import type { Env } from "./types.ts";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const requestId = extractOrCreateRequestId(request);

    try {
      switch (request.method) {
        case "OPTIONS":
          return handleOptions(request, env, requestId);
        case "PUT":
          return await handleUpload(request, env, requestId);
        case "GET":
          return await handleView(request, env, requestId);
        case "HEAD":
          return await handleHead(request, env, requestId);
        default:
          return buildErrorResponse(
            makeError(
              "METHOD_NOT_ALLOWED",
              `${request.method} is not supported`,
              { method: request.method },
            ),
            corsHeaders(request, env, requestId),
          );
      }
    } catch (e) {
      // Last-resort guard. Handlers are written to never throw, but if one
      // does, we still emit a structured log + JSON error.
      log("ERROR", {
        op: "dispatch",
        code: "INTERNAL",
        requestId,
        userId: null,
        ip: request.headers.get("CF-Connecting-IP"),
        ua: truncateUa(request.headers.get("User-Agent")),
        extra: { cause: e instanceof Error ? e.message : String(e) },
      });
      return buildErrorResponse(
        makeError("INTERNAL", "Unhandled error", {
          cause: e instanceof Error ? e.message : String(e),
        }),
        corsHeaders(request, env, requestId),
      );
    }
  },
} satisfies ExportedHandler<Env>;
