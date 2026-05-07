// Path-traversal rejection. Contract §4.1 step 1 (PUT) and §4.2 step 1 (GET).
// Also enforces the prefix routing in §4.2: only public/* and private/* are
// served; other top-level prefixes return 404.

import { err, ok, type Result, type WorkerError } from "../types.ts";
import { makeError } from "./errors.ts";

const MAX_KEY_LENGTH = 1024;

// Returns the bare key (no leading slash) if valid, or PATH_TRAVERSAL.
export function validateKey(pathname: string): Result<string, WorkerError> {
  if (pathname.length > MAX_KEY_LENGTH + 1) {
    return err(
      makeError("PATH_TRAVERSAL", `Path exceeds ${MAX_KEY_LENGTH} chars`, {
        length: pathname.length,
      }),
    );
  }

  // Strip exactly one leading slash. URLs always pathname starts with `/`,
  // but be defensive.
  if (!pathname.startsWith("/")) {
    return err(makeError("PATH_TRAVERSAL", "Path must start with /"));
  }
  const key = pathname.slice(1);

  if (key.length === 0) {
    return err(makeError("PATH_TRAVERSAL", "Empty key"));
  }

  // Reject anything that decodes to a different value than its raw form
  // (i.e. percent-encoded segments). Legitimate keys only contain
  // [A-Za-z0-9._/-]. Reject backslash, double-slash, leading slash again,
  // and any `..` segment.
  if (!/^[A-Za-z0-9._\-/]+$/.test(key)) {
    return err(
      makeError("PATH_TRAVERSAL", "Path contains forbidden characters", {
        // Don't echo the full key — it could be attacker-controlled and
        // bloat logs. Just report the class.
      }),
    );
  }

  if (key.includes("//")) {
    return err(makeError("PATH_TRAVERSAL", "Path contains empty segment"));
  }

  // Segment-by-segment: no `.` or `..` segments anywhere.
  for (const segment of key.split("/")) {
    if (segment === "." || segment === "..") {
      return err(makeError("PATH_TRAVERSAL", "Path contains relative segment"));
    }
  }

  return ok(key);
}

// Confirm the key is under public/ or private/. Per §4.2: other paths → 404.
// Returned as a separate function so PUT (which only allows specific prefixes
// implicitly via the JWT key claim) and GET (which must reject other paths)
// can share the same primitive.
export function getKeyVisibility(key: string): "public" | "private" | "other" {
  if (key.startsWith("public/")) return "public";
  if (key.startsWith("private/")) return "private";
  return "other";
}
