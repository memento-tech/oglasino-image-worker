// Test helpers: sign tokens, build requests, drive the Worker.

import { SELF } from "cloudflare:test";
import { SignJWT } from "jose";

import { ISSUER, type UploadJwtClaims, type ViewJwtClaims } from "../src/types.ts";

const encoder = new TextEncoder();

export const TEST_JWT_SECRET = "test-jwt-signing-secret-32-bytes-min-yes";
export const TEST_BACKEND_SECRET = "test-backend-shared-secret-32b-min-please";

export interface SignOptions {
  secret?: string;
  notExpired?: boolean;
  iss?: string;
}

type WithoutBaseClaims<T> = Omit<T, "iss" | "iat" | "exp" | "jti" | "sub" | "scope">;

const baseUploadClaims = {
  iss: ISSUER,
  scope: "upload" as const,
};
const baseViewClaims = {
  iss: ISSUER,
  scope: "view" as const,
};

export async function signUploadJwt(
  partial: WithoutBaseClaims<UploadJwtClaims> & { sub?: string; jti?: string },
  options: SignOptions = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = options.notExpired === false ? now - 60 : now + 600;
  const iss = options.iss ?? baseUploadClaims.iss;

  const payload = {
    ...baseUploadClaims,
    iss,
    sub: partial.sub ?? "user-123",
    jti: partial.jti ?? crypto.randomUUID(),
    kind: partial.kind,
    key: partial.key,
    contentType: partial.contentType,
    maxBytes: partial.maxBytes,
  };

  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(encoder.encode(options.secret ?? TEST_JWT_SECRET));
}

export async function signViewJwt(
  partial: WithoutBaseClaims<ViewJwtClaims> & { sub?: string; jti?: string },
  options: SignOptions = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = options.notExpired === false ? now - 60 : now + 14400;
  const iss = options.iss ?? baseViewClaims.iss;

  const payload = {
    ...baseViewClaims,
    iss,
    sub: partial.sub ?? "user-123",
    jti: partial.jti ?? crypto.randomUUID(),
    kind: partial.kind,
    keyPrefix: partial.keyPrefix,
    chatId: partial.chatId,
  };

  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(encoder.encode(options.secret ?? TEST_JWT_SECRET));
}

export interface RequestBuildArgs {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  origin?: string;
}

export function buildRequest(args: RequestBuildArgs): Request {
  const url = `https://cdn.test.oglasino.com${args.path}`;
  const headers = new Headers(args.headers ?? {});
  if (args.origin) headers.set("Origin", args.origin);
  return new Request(url, {
    method: args.method,
    headers,
    body: args.body ?? null,
  });
}

export async function dispatch(request: Request, _env?: unknown): Promise<Response> {
  // SELF.fetch dispatches through the runtime's worker entry point so
  // isolated R2 storage and JSRPC streaming work correctly. The env arg is
  // accepted but ignored — kept so call sites read symmetrically with the
  // worker.fetch signature.
  return await SELF.fetch(request);
}

export interface JsonError {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    retryable: boolean;
  };
}
