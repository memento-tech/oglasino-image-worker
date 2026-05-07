import { env } from "cloudflare:test";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { verifyUploadJwt, verifyViewJwt } from "../src/auth/jwt.ts";
import { signUploadJwt, signViewJwt, TEST_JWT_SECRET } from "./helpers.ts";

const encoder = new TextEncoder();

describe("verifyUploadJwt", () => {
  it("accepts a valid token", async () => {
    const token = await signUploadJwt({
      kind: "product",
      key: "public/products/abc.jpg",
      contentType: "image/jpeg",
      maxBytes: 10485760,
    });
    const r = await verifyUploadJwt(token, env);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.scope).toBe("upload");
      expect(r.value.key).toBe("public/products/abc.jpg");
    }
  });

  it("rejects expired token", async () => {
    const token = await signUploadJwt(
      {
        kind: "product",
        key: "public/products/abc.jpg",
        contentType: "image/jpeg",
        maxBytes: 10485760,
      },
      { notExpired: false },
    );
    const r = await verifyUploadJwt(token, env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("TOKEN_EXPIRED");
  });

  it("rejects wrong-secret signature", async () => {
    const token = await signUploadJwt(
      {
        kind: "product",
        key: "public/products/abc.jpg",
        contentType: "image/jpeg",
        maxBytes: 10485760,
      },
      { secret: "completely-different-secret-32-bytes-pls" },
    );
    const r = await verifyUploadJwt(token, env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("TOKEN_SIGNATURE_INVALID");
  });

  it("rejects wrong issuer", async () => {
    const token = await signUploadJwt(
      {
        kind: "product",
        key: "public/products/abc.jpg",
        contentType: "image/jpeg",
        maxBytes: 10485760,
      },
      { iss: "not-oglasino-backend" },
    );
    const r = await verifyUploadJwt(token, env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("TOKEN_ISSUER_INVALID");
  });

  it("rejects scope=view used as upload", async () => {
    const view = await signViewJwt({
      kind: "chat",
      keyPrefix: "private/chats/abc/",
      chatId: "abc",
    });
    const r = await verifyUploadJwt(view, env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("TOKEN_SCOPE_MISMATCH");
  });

  it("rejects malformed token", async () => {
    const r = await verifyUploadJwt("garbage.not.jwt", env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("TOKEN_MALFORMED");
  });

  it("falls back to JWT_SIGNING_SECRET_PREVIOUS during rotation", async () => {
    const previousSecret = "previous-secret-32-bytes-or-more-yes";
    const token = await signUploadJwt(
      {
        kind: "product",
        key: "public/products/abc.jpg",
        contentType: "image/jpeg",
        maxBytes: 10485760,
      },
      { secret: previousSecret },
    );

    // Synthesize an env with the rotation in effect: current is the test
    // default (different), previous is the secret we signed with.
    const rotEnv = {
      ...env,
      JWT_SIGNING_SECRET_PREVIOUS: previousSecret,
    };

    const r = await verifyUploadJwt(token, rotEnv);
    expect(r.ok).toBe(true);
  });

  it("fails if neither current nor previous secret matches", async () => {
    const token = await signUploadJwt(
      {
        kind: "product",
        key: "public/products/abc.jpg",
        contentType: "image/jpeg",
        maxBytes: 10485760,
      },
      { secret: "yet-another-rogue-secret-32-bytes-min-yep" },
    );
    const rotEnv = {
      ...env,
      JWT_SIGNING_SECRET_PREVIOUS: "some-other-prev-secret-32-bytes-min-yep",
    };
    const r = await verifyUploadJwt(token, rotEnv);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("TOKEN_SIGNATURE_INVALID");
  });

  it("rejects upload JWT missing required claims", async () => {
    // Hand-craft a JWT that's HS256-signed but missing `key`.
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      iss: "oglasino-backend",
      sub: "user-1",
      jti: "j-1",
      scope: "upload",
      kind: "product",
      // key intentionally omitted
      contentType: "image/jpeg",
      maxBytes: 10485760,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(encoder.encode(TEST_JWT_SECRET));

    const r = await verifyUploadJwt(token, env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("TOKEN_MALFORMED");
  });
});

describe("verifyViewJwt", () => {
  it("accepts a valid view token", async () => {
    const token = await signViewJwt({
      kind: "chat",
      keyPrefix: "private/chats/abc/",
      chatId: "abc",
    });
    const r = await verifyViewJwt(token, env);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.keyPrefix).toBe("private/chats/abc/");
  });

  it("rejects expired view token", async () => {
    const token = await signViewJwt(
      {
        kind: "chat",
        keyPrefix: "private/chats/abc/",
        chatId: "abc",
      },
      { notExpired: false },
    );
    const r = await verifyViewJwt(token, env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("TOKEN_EXPIRED");
  });

  it("rejects upload-scope token used as view", async () => {
    const upload = await signUploadJwt({
      kind: "product",
      key: "public/products/abc.jpg",
      contentType: "image/jpeg",
      maxBytes: 10485760,
    });
    const r = await verifyViewJwt(upload, env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("TOKEN_SCOPE_MISMATCH");
  });
});
