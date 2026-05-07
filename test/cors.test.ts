import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { buildRequest, dispatch } from "./helpers.ts";

describe("CORS", () => {
  it("echoes allowed origin on preflight", async () => {
    const res = await dispatch(
      buildRequest({
        method: "OPTIONS",
        path: "/public/products/x.jpg",
        origin: "https://oglasino.com",
        headers: { "Access-Control-Request-Method": "GET" },
      }),
      env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://oglasino.com",
    );
    expect(res.headers.get("Vary")).toBe("Origin");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    expect(res.headers.get("Access-Control-Max-Age")).toBe("86400");
  });

  it("does not echo disallowed origin", async () => {
    const res = await dispatch(
      buildRequest({
        method: "OPTIONS",
        path: "/public/products/x.jpg",
        origin: "https://evil.com",
      }),
      env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("matches Vercel preview wildcard suffix", async () => {
    const res = await dispatch(
      buildRequest({
        method: "OPTIONS",
        path: "/public/products/x.jpg",
        origin: "https://oglasino-web-feature-branch-xyz.vercel.app",
      }),
      env,
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://oglasino-web-feature-branch-xyz.vercel.app",
    );
  });

  it("rejects vercel preview from other projects", async () => {
    const res = await dispatch(
      buildRequest({
        method: "OPTIONS",
        path: "/public/products/x.jpg",
        origin: "https://attacker-app-foo.vercel.app",
      }),
      env,
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("never echoes a literal *", async () => {
    const res = await dispatch(
      buildRequest({
        method: "OPTIONS",
        path: "/public/products/x.jpg",
        origin: "https://oglasino.com",
      }),
      env,
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).not.toBe("*");
  });

  it("emits x-request-id on every response", async () => {
    const res = await dispatch(
      buildRequest({
        method: "OPTIONS",
        path: "/public/products/x.jpg",
        origin: "https://oglasino.com",
      }),
      env,
    );
    expect(res.headers.get("x-request-id")).toMatch(
      /^[0-9a-f-]{36}$/i,
    );
  });

  it("echoes caller-supplied x-request-id", async () => {
    const res = await dispatch(
      buildRequest({
        method: "OPTIONS",
        path: "/public/products/x.jpg",
        origin: "https://oglasino.com",
        headers: { "x-request-id": "test-req-abc-123" },
      }),
      env,
    );
    expect(res.headers.get("x-request-id")).toBe("test-req-abc-123");
  });
});
