// JWT verify per contract §5. HS256 only. Dual-secret rotation window:
// try current first, fall back to previous on signature failure (§2.3, §5.6).

import { errors as joseErrors, jwtVerify } from "jose";

import {
  err,
  ok,
  ISSUER,
  type BaseJwtClaims,
  type Env,
  type Result,
  type UploadJwtClaims,
  type ViewJwtClaims,
  type WorkerError,
} from "../types.ts";
import { makeError } from "../lib/errors.ts";

type ExpectedScope = "upload" | "view";

const encoder = new TextEncoder();

function asKey(secret: string): Uint8Array {
  return encoder.encode(secret);
}

interface VerifyOk<T> {
  claims: T;
  usedPrevious: boolean;
}

// Verify a JWT and return its typed claims. Errors map directly to contract
// error codes (§8.2):
//   - signature failure  → TOKEN_SIGNATURE_INVALID
//   - exp in past        → TOKEN_EXPIRED
//   - iss mismatch       → TOKEN_ISSUER_INVALID
//   - parse failure      → TOKEN_MALFORMED
//   - scope mismatch     → TOKEN_SCOPE_MISMATCH
async function verifyWithScope<T extends BaseJwtClaims>(
  token: string,
  env: Env,
  expectedScope: ExpectedScope,
): Promise<Result<VerifyOk<T>, WorkerError>> {
  // Try current secret.
  const current = await tryVerify<T>(token, env.JWT_SIGNING_SECRET);

  if (current.outcome === "ok") {
    return validateScope<T>(current.claims, expectedScope, false);
  }

  // Only signature failures are eligible for previous-secret retry. Expired
  // / malformed / wrong issuer are not signature problems and would just
  // re-fail with the same diagnosis.
  if (
    current.outcome === "signature-invalid" &&
    env.JWT_SIGNING_SECRET_PREVIOUS !== undefined &&
    env.JWT_SIGNING_SECRET_PREVIOUS.length > 0
  ) {
    const prev = await tryVerify<T>(token, env.JWT_SIGNING_SECRET_PREVIOUS);
    if (prev.outcome === "ok") {
      return validateScope<T>(prev.claims, expectedScope, true);
    }
    // Both secrets rejected the signature.
    return err(
      makeError(
        "TOKEN_SIGNATURE_INVALID",
        "JWT signature did not verify against current or previous secret",
      ),
    );
  }

  return err(mapVerifyOutcome(current));
}

type VerifyOutcome<T> =
  | { outcome: "ok"; claims: T }
  | { outcome: "expired" }
  | { outcome: "issuer-invalid"; got: unknown }
  | { outcome: "malformed" }
  | { outcome: "signature-invalid" }
  | { outcome: "claims-invalid"; reason: string };

async function tryVerify<T>(
  token: string,
  secret: string,
): Promise<VerifyOutcome<T>> {
  try {
    const { payload } = await jwtVerify(token, asKey(secret), {
      issuer: ISSUER,
      algorithms: ["HS256"],
      typ: "JWT",
    });
    return { outcome: "ok", claims: payload as unknown as T };
  } catch (e: unknown) {
    if (e instanceof joseErrors.JWTExpired) return { outcome: "expired" };
    if (e instanceof joseErrors.JWSSignatureVerificationFailed) {
      return { outcome: "signature-invalid" };
    }
    if (e instanceof joseErrors.JWTClaimValidationFailed) {
      if (e.claim === "iss") {
        return { outcome: "issuer-invalid", got: e.payload };
      }
      return { outcome: "claims-invalid", reason: e.claim ?? "unknown" };
    }
    if (
      e instanceof joseErrors.JWTInvalid ||
      e instanceof joseErrors.JWSInvalid ||
      e instanceof joseErrors.JOSEAlgNotAllowed ||
      e instanceof joseErrors.JOSENotSupported
    ) {
      return { outcome: "malformed" };
    }
    // Anything unrecognized → treat as malformed; we never let unexpected
    // throws bubble out of auth.
    return { outcome: "malformed" };
  }
}

function mapVerifyOutcome<T>(outcome: VerifyOutcome<T>): WorkerError {
  switch (outcome.outcome) {
    case "expired":
      return makeError("TOKEN_EXPIRED", "JWT exp is in the past");
    case "issuer-invalid":
      return makeError("TOKEN_ISSUER_INVALID", "JWT iss claim mismatch");
    case "malformed":
      return makeError("TOKEN_MALFORMED", "JWT failed to parse");
    case "signature-invalid":
      return makeError(
        "TOKEN_SIGNATURE_INVALID",
        "JWT signature did not verify",
      );
    case "claims-invalid":
      return makeError("TOKEN_MALFORMED", `JWT claim invalid: ${outcome.reason}`);
    case "ok":
      // Should never reach here.
      return makeError("INTERNAL", "Unreachable verify outcome");
  }
}

function validateScope<T extends BaseJwtClaims>(
  claims: T,
  expectedScope: ExpectedScope,
  usedPrevious: boolean,
): Result<VerifyOk<T>, WorkerError> {
  if (claims.scope !== expectedScope) {
    return err(
      makeError(
        "TOKEN_SCOPE_MISMATCH",
        `Token scope is ${claims.scope}, expected ${expectedScope}`,
        { expected: expectedScope, got: claims.scope },
      ),
    );
  }
  return ok({ claims, usedPrevious });
}

export async function verifyUploadJwt(
  token: string,
  env: Env,
): Promise<Result<UploadJwtClaims, WorkerError>> {
  const result = await verifyWithScope<UploadJwtClaims>(token, env, "upload");
  if (!result.ok) return result;
  // Sanity: required upload claims must be present and well-typed.
  const c = result.value.claims;
  if (
    typeof c.key !== "string" ||
    typeof c.contentType !== "string" ||
    typeof c.maxBytes !== "number" ||
    c.key.length === 0
  ) {
    return err(makeError("TOKEN_MALFORMED", "Upload JWT missing required claims"));
  }
  return ok(c);
}

export async function verifyViewJwt(
  token: string,
  env: Env,
): Promise<Result<ViewJwtClaims, WorkerError>> {
  const result = await verifyWithScope<ViewJwtClaims>(token, env, "view");
  if (!result.ok) return result;
  const c = result.value.claims;
  if (
    typeof c.keyPrefix !== "string" ||
    c.keyPrefix.length === 0 ||
    typeof c.chatId !== "string"
  ) {
    return err(makeError("TOKEN_MALFORMED", "View JWT missing required claims"));
  }
  return ok(c);
}
