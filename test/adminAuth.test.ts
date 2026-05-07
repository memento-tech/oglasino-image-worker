// Backend auth (X-Backend-Auth) is unused by any v1 endpoint, but the
// constant-time compare and the verifyAdminAuth contract are exercised here
// so that adding admin endpoints later doesn't require re-deriving these
// behaviours.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  timingSafeEqual,
  verifyAdminAuth,
} from "../src/auth/adminAuth.ts";
import { TEST_BACKEND_SECRET } from "./helpers.ts";

function buildAdminRequest(headers: Record<string, string>): Request {
  return new Request("https://cdn.test.oglasino.com/api/admin/anything", {
    method: "POST",
    headers,
  });
}

describe("verifyAdminAuth", () => {
  it("returns ok with the correct shared secret", () => {
    const r = verifyAdminAuth(
      buildAdminRequest({ "X-Backend-Auth": TEST_BACKEND_SECRET }),
      env,
    );
    expect(r.ok).toBe(true);
  });

  it("returns BACKEND_AUTH_MISSING when header absent", () => {
    const r = verifyAdminAuth(buildAdminRequest({}), env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("BACKEND_AUTH_MISSING");
  });

  it("returns BACKEND_AUTH_INVALID with wrong secret", () => {
    const r = verifyAdminAuth(
      buildAdminRequest({ "X-Backend-Auth": "definitely-not-the-secret" }),
      env,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("BACKEND_AUTH_INVALID");
  });
});

describe("timingSafeEqual", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqual("hello", "hello")).toBe(true);
  });

  it("returns false for different strings of same length", () => {
    expect(timingSafeEqual("hello", "world")).toBe(false);
  });

  it("returns false for different lengths", () => {
    expect(timingSafeEqual("hello", "hello!")).toBe(false);
  });

  it("returns true for empty strings", () => {
    expect(timingSafeEqual("", "")).toBe(true);
  });
});
