import { describe, expect, it } from "vitest";

import { getKeyVisibility, validateKey } from "../src/lib/pathValidation.ts";

describe("validateKey", () => {
  it("accepts a normal public key", () => {
    const r = validateKey("/public/products/abc-123.jpg");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("public/products/abc-123.jpg");
  });

  it("accepts a normal private chat key", () => {
    const r = validateKey("/private/chats/chat-1/img-abc.jpg");
    expect(r.ok).toBe(true);
  });

  it("rejects ../ traversal", () => {
    const r = validateKey("/public/../private/chats/secret.jpg");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("PATH_TRAVERSAL");
  });

  it("rejects absolute backslash path", () => {
    const r = validateKey("/public\\products\\abc.jpg");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("PATH_TRAVERSAL");
  });

  it("rejects percent-encoded dot-dot", () => {
    const r = validateKey("/public/%2e%2e/private/secret.jpg");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("PATH_TRAVERSAL");
  });

  it("rejects double slash", () => {
    const r = validateKey("/public//products/abc.jpg");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("PATH_TRAVERSAL");
  });

  it("rejects empty key", () => {
    const r = validateKey("/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("PATH_TRAVERSAL");
  });

  it("rejects excessively long key", () => {
    const long = `/public/${"a".repeat(2000)}.jpg`;
    const r = validateKey(long);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("PATH_TRAVERSAL");
  });

  it("rejects single-dot segment", () => {
    const r = validateKey("/public/./products/abc.jpg");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("PATH_TRAVERSAL");
  });

  it("rejects spaces and special chars", () => {
    const r = validateKey("/public/products/abc 123.jpg");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("PATH_TRAVERSAL");
  });
});

describe("getKeyVisibility", () => {
  it("classifies public keys", () => {
    expect(getKeyVisibility("public/products/x.jpg")).toBe("public");
  });
  it("classifies private keys", () => {
    expect(getKeyVisibility("private/chats/x/y.jpg")).toBe("private");
  });
  it("classifies anything else as other", () => {
    expect(getKeyVisibility("admin/x.jpg")).toBe("other");
    expect(getKeyVisibility("foo")).toBe("other");
  });
});
