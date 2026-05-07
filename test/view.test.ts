import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  buildRequest,
  dispatch,
  signViewJwt,
  type JsonError,
} from "./helpers.ts";

// vitest-pool-workers isolates R2 storage per-test.

const sampleBytes = new Uint8Array(1024).fill(0xcd);

describe("GET /public/* (no auth)", () => {
  it("200 with bytes when key exists", async () => {
    await env.BUCKET.put("public/products/abc.jpg", sampleBytes, {
      httpMetadata: { contentType: "image/jpeg" },
    });

    const res = await dispatch(
      buildRequest({ method: "GET", path: "/public/products/abc.jpg" }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(res.headers.get("Vary")).toContain("Accept");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.byteLength).toBe(sampleBytes.byteLength);
  });

  it("404 when key does not exist", async () => {
    const res = await dispatch(
      buildRequest({ method: "GET", path: "/public/products/missing.jpg" }),
      env,
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as JsonError).error.code).toBe(
      "OBJECT_NOT_FOUND",
    );
  });

  it("does not require a token for public/", async () => {
    await env.BUCKET.put("public/products/no-token.jpg", sampleBytes, {
      httpMetadata: { contentType: "image/jpeg" },
    });
    const res = await dispatch(
      buildRequest({ method: "GET", path: "/public/products/no-token.jpg" }),
      env,
    );
    expect(res.status).toBe(200);
  });
});

describe("GET /private/* (token required)", () => {
  it("200 with valid view token", async () => {
    const key = "private/chats/chat-1/abc.jpg";
    await env.BUCKET.put(key, sampleBytes, {
      httpMetadata: { contentType: "image/jpeg" },
    });
    const token = await signViewJwt({
      kind: "chat",
      keyPrefix: "private/chats/chat-1/",
      chatId: "chat-1",
    });
    const res = await dispatch(
      buildRequest({
        method: "GET",
        path: `/${key}?token=${encodeURIComponent(token)}`,
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=300");
  });

  it("400 TOKEN_MISSING when no ?token", async () => {
    const res = await dispatch(
      buildRequest({
        method: "GET",
        path: "/private/chats/chat-1/abc.jpg",
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as JsonError).error.code).toBe("TOKEN_MISSING");
  });

  it("401 TOKEN_EXPIRED with expired view token", async () => {
    const token = await signViewJwt(
      {
        kind: "chat",
        keyPrefix: "private/chats/chat-1/",
        chatId: "chat-1",
      },
      { notExpired: false },
    );
    const res = await dispatch(
      buildRequest({
        method: "GET",
        path: `/private/chats/chat-1/abc.jpg?token=${encodeURIComponent(token)}`,
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as JsonError).error.code).toBe("TOKEN_EXPIRED");
  });

  it("403 TOKEN_KEY_MISMATCH when key prefix does not cover request", async () => {
    const token = await signViewJwt({
      kind: "chat",
      keyPrefix: "private/chats/chat-1/",
      chatId: "chat-1",
    });
    const res = await dispatch(
      buildRequest({
        method: "GET",
        path: `/private/chats/chat-2/abc.jpg?token=${encodeURIComponent(token)}`,
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as JsonError).error.code).toBe(
      "TOKEN_KEY_MISMATCH",
    );
  });

  it("404 when key matches prefix but R2 has no object", async () => {
    const token = await signViewJwt({
      kind: "chat",
      keyPrefix: "private/chats/chat-1/",
      chatId: "chat-1",
    });
    const res = await dispatch(
      buildRequest({
        method: "GET",
        path: `/private/chats/chat-1/missing.jpg?token=${encodeURIComponent(token)}`,
      }),
      env,
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as JsonError).error.code).toBe(
      "OBJECT_NOT_FOUND",
    );
  });
});

describe("GET /other/* (404)", () => {
  it("returns 404 for paths that aren't public/ or private/", async () => {
    const res = await dispatch(
      buildRequest({ method: "GET", path: "/admin/anything" }),
      env,
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as JsonError).error.code).toBe(
      "OBJECT_NOT_FOUND",
    );
  });
});

describe("HEAD /{key}", () => {
  it("200 with headers but no body for public", async () => {
    const key = "public/products/head.jpg";
    await env.BUCKET.put(key, sampleBytes, {
      httpMetadata: { contentType: "image/jpeg" },
    });
    const res = await dispatch(
      buildRequest({ method: "HEAD", path: `/${key}` }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Content-Length")).toBe(
      String(sampleBytes.byteLength),
    );
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBe(0);
  });

  it("404 when key does not exist", async () => {
    const res = await dispatch(
      buildRequest({ method: "HEAD", path: "/public/products/missing.jpg" }),
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe("Method not allowed", () => {
  it("returns 405 on POST", async () => {
    const res = await dispatch(
      buildRequest({ method: "POST", path: "/public/products/x.jpg" }),
      env,
    );
    expect(res.status).toBe(405);
  });

  it("returns 405 on DELETE", async () => {
    const res = await dispatch(
      buildRequest({ method: "DELETE", path: "/public/products/x.jpg" }),
      env,
    );
    expect(res.status).toBe(405);
  });
});
