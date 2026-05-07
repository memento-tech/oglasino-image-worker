import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  buildRequest,
  dispatch,
  signUploadJwt,
  type JsonError,
} from "./helpers.ts";

// vitest-pool-workers gives each test a fresh isolated R2 storage stack,
// so no per-test cleanup is needed.

const sampleBytes = new Uint8Array(2048).fill(0xab);
const sampleLen = sampleBytes.byteLength;

describe("PUT /{key} happy path", () => {
  it("uploads a valid JPEG", async () => {
    const key = "public/products/abc-123.jpg";
    const token = await signUploadJwt({
      kind: "product",
      key,
      contentType: "image/jpeg",
      maxBytes: 10485760,
    });

    const res = await dispatch(
      buildRequest({
        method: "PUT",
        path: `/${key}`,
        headers: {
          "x-upload-token": token,
          "Content-Type": "image/jpeg",
          "Content-Length": String(sampleLen),
        },
        body: sampleBytes,
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string; bytes: number; contentType: string };
    expect(body.key).toBe(key);
    expect(body.bytes).toBe(sampleLen);
    expect(body.contentType).toBe("image/jpeg");

    // Object actually written.
    const obj = await env.BUCKET.get(key);
    expect(obj).not.toBeNull();
    expect(obj?.size).toBe(sampleLen);
  });
});

describe("PUT /{key} error paths", () => {
  it("400 TOKEN_MISSING when no x-upload-token header", async () => {
    const res = await dispatch(
      buildRequest({
        method: "PUT",
        path: "/public/products/x.jpg",
        headers: {
          "Content-Type": "image/jpeg",
          "Content-Length": String(sampleLen),
        },
        body: sampleBytes,
      }),
      env,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as JsonError;
    expect(json.error.code).toBe("TOKEN_MISSING");
  });

  it("400 PATH_TRAVERSAL when path contains a forbidden character", async () => {
    // Note on path traversal at the dispatch layer:
    //   - Literal `..` is collapsed by the URL constructor before the
    //     Worker ever sees it.
    //   - `%2e%2e` is decoded by the WHATWG URL parser for special schemes
    //     and likewise resolved out.
    //   - `\\` is treated as `/` for special schemes and gets normalized.
    // So those vectors are platform-defended. The pathValidation.test.ts
    // unit tests still cover the validator's behaviour on the raw inputs
    // for defense-in-depth.
    //
    // What DOES reach the Worker unchanged is anything outside the path
    // allowlist, e.g. a space in a filename (becomes `%20` in pathname),
    // which the validator rejects.
    const token = await signUploadJwt({
      kind: "product",
      key: "public/products/abc.jpg",
      contentType: "image/jpeg",
      maxBytes: 10485760,
    });
    const res = await dispatch(
      buildRequest({
        method: "PUT",
        path: "/public/products/abc def.jpg",
        headers: {
          "x-upload-token": token,
          "Content-Type": "image/jpeg",
          "Content-Length": String(sampleLen),
        },
        body: sampleBytes,
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as JsonError).error.code).toBe("PATH_TRAVERSAL");
  });

  it("403 TOKEN_KEY_MISMATCH when JWT key differs from request path", async () => {
    const token = await signUploadJwt({
      kind: "product",
      key: "public/products/expected.jpg",
      contentType: "image/jpeg",
      maxBytes: 10485760,
    });
    const res = await dispatch(
      buildRequest({
        method: "PUT",
        path: "/public/products/different.jpg",
        headers: {
          "x-upload-token": token,
          "Content-Type": "image/jpeg",
          "Content-Length": String(sampleLen),
        },
        body: sampleBytes,
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as JsonError).error.code).toBe("TOKEN_KEY_MISMATCH");
  });

  it("415 CONTENT_TYPE_MISMATCH when header doesn't match JWT contentType", async () => {
    const key = "public/products/abc.jpg";
    const token = await signUploadJwt({
      kind: "product",
      key,
      contentType: "image/jpeg",
      maxBytes: 10485760,
    });
    const res = await dispatch(
      buildRequest({
        method: "PUT",
        path: `/${key}`,
        headers: {
          "x-upload-token": token,
          "Content-Type": "image/png",
          "Content-Length": String(sampleLen),
        },
        body: sampleBytes,
      }),
      env,
    );
    expect(res.status).toBe(415);
    expect(((await res.json()) as JsonError).error.code).toBe("CONTENT_TYPE_MISMATCH");
  });

  it("413 FILE_TOO_LARGE when Content-Length exceeds JWT maxBytes", async () => {
    const key = "public/products/abc.jpg";
    const token = await signUploadJwt({
      kind: "product",
      key,
      contentType: "image/jpeg",
      maxBytes: 1024, // small cap
    });
    const res = await dispatch(
      buildRequest({
        method: "PUT",
        path: `/${key}`,
        headers: {
          "x-upload-token": token,
          "Content-Type": "image/jpeg",
          "Content-Length": String(sampleLen), // > 1024
        },
        body: sampleBytes,
      }),
      env,
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as JsonError).error.code).toBe("FILE_TOO_LARGE");
  });

  it("415 CONTENT_TYPE_NOT_ALLOWED when type not in env allowlist", async () => {
    const key = "public/products/abc.svg";
    const token = await signUploadJwt({
      kind: "product",
      key,
      contentType: "image/svg+xml",
      maxBytes: 10485760,
    });
    const res = await dispatch(
      buildRequest({
        method: "PUT",
        path: `/${key}`,
        headers: {
          "x-upload-token": token,
          "Content-Type": "image/svg+xml",
          "Content-Length": String(sampleLen),
        },
        body: sampleBytes,
      }),
      env,
    );
    expect(res.status).toBe(415);
    expect(((await res.json()) as JsonError).error.code).toBe("CONTENT_TYPE_NOT_ALLOWED");
  });

  it("401 TOKEN_EXPIRED when JWT exp is in the past", async () => {
    const key = "public/products/abc.jpg";
    const token = await signUploadJwt(
      { kind: "product", key, contentType: "image/jpeg", maxBytes: 10485760 },
      { notExpired: false },
    );
    const res = await dispatch(
      buildRequest({
        method: "PUT",
        path: `/${key}`,
        headers: {
          "x-upload-token": token,
          "Content-Type": "image/jpeg",
          "Content-Length": String(sampleLen),
        },
        body: sampleBytes,
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as JsonError).error.code).toBe("TOKEN_EXPIRED");
  });

  it("401 TOKEN_SIGNATURE_INVALID with wrong-secret token", async () => {
    const key = "public/products/abc.jpg";
    const token = await signUploadJwt(
      { kind: "product", key, contentType: "image/jpeg", maxBytes: 10485760 },
      { secret: "rogue-signing-secret-32-bytes-or-more-yes" },
    );
    const res = await dispatch(
      buildRequest({
        method: "PUT",
        path: `/${key}`,
        headers: {
          "x-upload-token": token,
          "Content-Type": "image/jpeg",
          "Content-Length": String(sampleLen),
        },
        body: sampleBytes,
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as JsonError).error.code).toBe(
      "TOKEN_SIGNATURE_INVALID",
    );
  });
});

describe("PUT idempotent retry", () => {
  it("returns 200 on second PUT of identical bytes without re-writing", async () => {
    const key = "public/products/idempotent.jpg";
    const token = await signUploadJwt({
      kind: "product",
      key,
      contentType: "image/jpeg",
      maxBytes: 10485760,
    });

    const doPut = () =>
      dispatch(
        buildRequest({
          method: "PUT",
          path: `/${key}`,
          headers: {
            "x-upload-token": token,
            "Content-Type": "image/jpeg",
            "Content-Length": String(sampleLen),
          },
          body: sampleBytes,
        }),
        env,
      );

    const r1 = await doPut();
    expect(r1.status).toBe(200);
    const after1 = await env.BUCKET.head(key);
    const etag1 = after1?.etag ?? null;

    const r2 = await doPut();
    expect(r2.status).toBe(200);
    const after2 = await env.BUCKET.head(key);

    // Idempotent path means we did NOT re-write. R2 etag is content-derived,
    // so even an overwrite of the same bytes yields the same etag — but
    // miniflare's R2 implementation regenerates etag on write. We assert the
    // size and content-type are unchanged, which is what the contract
    // promises.
    expect(after2?.size).toBe(after1?.size);
    expect(after2?.httpMetadata?.contentType).toBe(
      after1?.httpMetadata?.contentType,
    );
    // etag should be stable across an idempotent skip; if the test runner's
    // R2 mock changes etag on every PUT this assertion can be relaxed.
    expect(after2?.etag).toBe(etag1);
  });
});
