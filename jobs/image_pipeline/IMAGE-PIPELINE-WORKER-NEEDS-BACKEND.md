# Image Pipeline — Worker Contract: Backend Requirements

**Owner:** Backend agent
**Status:** Draft for consolidation into unified Worker contract
**Last updated:** 2026-05-07
**Companion docs:** `IMAGE-PIPELINE-SPEC.md` (master spec),
`IMAGE-PIPELINE-WORKER-NEEDS-FRONTEND.md` (peer),
`IMAGE-PIPELINE-BACKEND-AUDIT.md` (Phase 1 inventory)

---

## 0. Purpose and scope

This document captures **what the Spring Boot backend needs from the
new Cloudflare Worker** so that the unified Worker contract can be
drafted. It is paired with the frontend's needs document; together
they're the inputs to the unified contract.

The contract authority is split deliberately:

- **Frontend's needs** lock down the wire shapes for client→Worker
  uploads/downloads, error JSON, CORS, and what data the client gets
  back.
- **Backend's needs** lock down server-to-server admin operations
  (delete), the JWT issuance model, the path/key conventions
  persisted in DB, and the dual-secret auth model.

Where they overlap (e.g., JWT claims structure, error codes), the
backend defers to frontend's lock-ins unless flagged otherwise. All
disagreements are listed in §I and §L.

The frontend's audit makes one important observation we should
restate: **the contract is consumed by both Next.js web and React
Native iOS/Android.** The backend treats those identically — see §K.

---

## A. Authentication and authorization (backend → Worker)

### A.1 Two distinct auth concerns — keep them separate

The prompt is explicit and the backend agrees: there are **two**
authentication models in the new contract, with **different
secrets**:

| Concern | Auth | Secret | Format | Verified by |
|---|---|---|---|---|
| **Backend → Worker** (admin operations: delete, list, head) | Static shared secret in custom header | `BACKEND_SHARED_SECRET` | Opaque high-entropy string | Worker compares (constant-time) against env var |
| **Client → Worker** (upload PUT, private GET) | JWT signed by backend, verified by Worker | `JWT_SIGNING_SECRET` (HS256) | JWT `iss`/`exp`/`iat`/`jti` + custom claims | Worker calls JWT-verify with HS256 + secret |

These secrets MUST be different values. Compromise of either should
not compromise the other.

- `BACKEND_SHARED_SECRET` is provisioned via `wrangler secret put`
  and exposed to backend as `BACKEND_WORKER_SHARED_SECRET` in
  `/opt/oglasino/.env`. Rotated rarely (manual quarterly drill).
- `JWT_SIGNING_SECRET` is the same on both sides; rotation requires
  a coordinated dual-key window (Worker accepts the old + new
  secret for one TTL, then drops the old) — see §I open question OQ-1.

### A.2 Backend → Worker auth header

**Proposed:**

```http
X-Backend-Auth: <BACKEND_SHARED_SECRET>
```

Custom header, **not** `Authorization: Bearer …` — that would conflict
with HS256 JWT bearers if we ever route a client request through the
backend's HTTP path. A custom header makes the auth model
self-documenting at the wire level.

Backend MUST send the header on every server-to-server call. Worker
MUST require the header and MUST NOT fall back to other auth methods
on the admin paths (defense-in-depth — accidental config changes
shouldn't open the admin endpoints to client traffic).

Constant-time comparison required on the Worker side (`crypto.subtle.timingSafeEqual`
or equivalent) to prevent timing attacks on the secret.

### A.3 No mutual TLS, no client certificates

Considered. Rejected for v1 because:

- mTLS with Cloudflare Workers is non-trivial (requires a Cloudflare
  Access policy, additional dashboard config, and rotation tooling).
- The backend is the only caller and lives on a trusted droplet; a
  shared secret is sufficient given the threat model.
- Adding mTLS later is straightforward (additive, doesn't change the
  contract).

### A.4 Today's `Bearer TOKEN_ID` becomes obsolete

The backend's current Worker auth (`Authorization: Bearer ${cloudflare.api.token}`)
is the same Cloudflare API token used elsewhere for KV writes —
it's wildly overscoped and should not be used for Worker auth in
the new model. The audit (`IMAGE-PIPELINE-BACKEND-AUDIT.md` §2.B)
confirms this. The new `X-Backend-Auth` header replaces it
entirely; `cloudflare.api.token` continues to be used **only** for
its legitimate Cloudflare API consumers (KV writes via
`DefaultCloudflareKvService`).

---

## B. Backend-only operations needed from Worker

### B.1 What the backend needs

Per the prompt's clarification (lines 122–135), JWT signing happens
at the backend — **not** at the Worker. So the operations the
backend needs from the Worker are exclusively R2-mutation operations
that the Worker is in a better position to perform than direct S3
calls would be.

But the backend already has direct R2 access via the AWS SDK
(`R2Service` — see audit §3). So **whether to route deletes through
the Worker is itself a decision**, not a given.

### B.2 Deletion: Worker endpoint vs direct R2 — backend's recommendation

**Recommendation: keep deletion direct via `R2Service`.** Don't add
Worker endpoints for delete in v1.

Reasons:

- `DefaultR2Service.deleteBulk` is already implemented, batches at
  S3's 1000-key limit, has structured per-key error logging
  (`R2Service.java:65-72`), and runs on the trusted droplet over the
  VPC. There's nothing the Worker would do better.
- Adding Worker delete endpoints introduces another wire format,
  another auth boundary, and another error-handling surface for no
  win.
- The Worker being lean (token verify + R2 read/write of bytes) is a
  contract simplification both teams want.

**Counter-case the contract author should consider:** if Worker logs
become the central audit trail for image operations (per §D), routing
deletes through the Worker would put deletion events in the same log
stream as uploads/views. Today the backend logs deletions to its own
SLF4J stream. If unified auditing matters more than simplicity, route
deletes through the Worker.

Backend's vote: **simplicity wins**, keep deletes direct, log
deletions on the backend side (SLF4J, MDC includes user/request IDs
already).

### B.3 If the contract decides to route deletes through the Worker anyway

Proposed shapes — included so they're ready:

#### `DELETE` single image

```http
DELETE {WORKER_URL}/api/admin/images/{key}
X-Backend-Auth: {BACKEND_SHARED_SECRET}
```

`{key}` is URL-encoded; can include slashes
(e.g., `private%2Fchats%2Fabc%2Fxyz.jpg`).

Success: `204 No Content`.

Errors: structured JSON per §E.

#### `POST` bulk delete (preferred over multiple DELETEs — single round-trip)

```http
POST {WORKER_URL}/api/admin/images/bulk-delete
X-Backend-Auth: {BACKEND_SHARED_SECRET}
Content-Type: application/json

{
  "keys": [
    "public/products/uuid-1.jpg",
    "private/chats/abc/uuid-2.jpg"
  ]
}
```

Success:

```json
{
  "deleted": 2,
  "errors": []
}
```

Partial failure:

```json
{
  "deleted": 1,
  "errors": [
    { "key": "private/chats/abc/uuid-2.jpg", "code": "OBJECT_NOT_FOUND" }
  ]
}
```

The Worker MUST chunk to S3's 1000-key limit internally; the contract
caller sends one logical batch.

### B.4 List by prefix — not needed in v1

Used today only by `ChatImagesRemovalJob` and the admin stats. Both
already use `R2Service.listObjectsV2` directly; routing through the
Worker would slow them down without benefit. **Backend declines this
endpoint.**

If the future cleanup utility for "find orphans" becomes a
standalone tool, it would still use direct R2 — same reasoning as
deletion.

### B.5 HEAD by key — not needed in v1

Frontend's open-question Q4 (idempotent retry on consumed token)
requires the Worker to do `R2.head()` internally before rejecting a
duplicate PUT. That's a Worker-internal concern; the backend doesn't
need a separate HEAD endpoint exposed.

### B.6 Token issuance is backend-side, not Worker-side

Restating the prompt's resolution: **the backend signs JWTs and
returns them to clients.** The Worker only verifies. Backend does
not call any Worker endpoint to "issue" a token.

This means the migration story for the existing Worker is a
significant simplification — the `/api/{accountId}/get-token` and
`/get-view-token` endpoints described in `IMAGE-PIPELINE-SPEC.md`
"Current state" go away entirely. The Worker becomes:

- `PUT /{key}` — verify upload JWT, write to R2
- `GET /{key}` — public read (allowlisted prefix) or verify view JWT
- (optional) admin delete endpoints per §B.3 (backend votes no)

---

## C. Path/key conventions

### C.1 Storage in DB — full key with prefix

**Backend's answer to frontend Q2: YES, store the full key with
prefix in DB.**

Reasoning:

- We're pre-production with disposable test data (per the spec); no
  data migration cost.
- Storing bare UUIDs forces the frontend to know the prefix
  convention (today: hardcoded `chat-images/{chatId}/` in
  `cloudflareService.ts:25-26`). That coupling has to break for the
  reorganization (`chat-images/` → `private/chats/`); this is the
  right time.
- Storing full keys means the backend can introspect a key string to
  decide whether it's public or private (`startsWith("public/")` vs
  `startsWith("private/")`) without an entity-side flag.
- It future-proofs the bucket reorganization. If we later split
  `public/products/` and `public/profiles/`, only the upload-token
  issuer needs to know which prefix to assign — every consumer just
  reads the key from the DB.

**Concrete impact on existing entities:**

| Entity field | Today's value | After migration |
|---|---|---|
| `Product.imageKeys` (`product_images.image_keys`) | `uuid-1`, `uuid-2`, … | `public/products/uuid-1.jpg`, … |
| `User.profileImageKey` | `uuid` | `public/profiles/uuid.jpg` (assuming the split — see §I OQ-3) |
| `Review.imageKeys` (`review_images.image_key`) | `uuid` | `public/products/uuid.jpg` (review images live with product images today; v2 may split) |

No `VARCHAR` length issue: all those columns are `TEXT` or
unrestricted in the V1 baseline. `\d+ public.product_images` in psql
to confirm if a maintainer is unsure.

### C.2 What the upload token endpoint returns

Per frontend §A.2 / §A.6:

```json
{
  "tokens": [
    {
      "token": "<JWT-HS256>",
      "key": "public/products/abc-123.jpg",
      "uploadUrl": "https://cdn.oglasino.com/public/products/abc-123.jpg",
      "expiresAt": "2026-05-07T14:30:00Z"
    }
  ]
}
```

Backend agrees with this shape. Notes:

- `key` is what gets persisted in the DB after PUT succeeds.
- `uploadUrl` is `{CDN_BASE}/{key}` — same hostname for upload
  (PUT) and read (GET); the Worker routes by method.
- `expiresAt` is ISO-8601 in UTC (`Z` suffix), derived server-side
  from `iat + UPLOAD_TOKEN_TTL_MS`.

### C.3 Path conventions backend chooses

Aligning with the spec's "target architecture":

| Scope | Prefix | Example |
|---|---|---|
| Product image | `public/products/` | `public/products/{uuid}.jpg` |
| Profile picture | `public/profiles/` | `public/profiles/{uuid}.jpg` |
| Review image | `public/products/` (no separate prefix v1) | `public/products/{uuid}.jpg` |
| Chat attachment | `private/chats/{chatId}/` | `private/chats/abc-123/{uuid}.jpg` |
| Brand assets (logo) | `public/brand/` | `public/brand/logo-watermark.png` |
| Future report attachment | `private/reports/{reportId}/` | (v2) |

Backend's preference is to **split profile pictures** into
`public/profiles/` from day one. Reasons in §I OQ-3.

Reviews stay under `public/products/` for v1 because they're the
same content domain and the reorganization isn't worth the churn.
Address again at v2 if reviews need their own retention or moderation
policy.

### C.4 Key segment validation

The Worker MUST reject keys containing:

- `..` (path traversal)
- absolute paths starting with `/` (after the prefix)
- backslashes
- URL-encoded path tricks (`%2e%2e`, `%2f`, etc., after decoding)
- empty segments (`public//products/...`)
- segments exceeding 256 chars

Return `400 PATH_TRAVERSAL` per frontend §C.2. Validation runs
**before** any R2 call (cheap rejection).

---

## D. Audit and observability

### D.1 No webhook needed

**Backend's position: rely on Cloudflare Logs, no webhook.**

Reasons:

- Cloudflare Logs (Workers Trace Events) is the lowest-friction
  audit trail — already exists, no additional infrastructure.
- A webhook back to the backend would couple Worker availability to
  backend availability for non-critical audit data.
- The backend already logs at SLF4J for every `/api/secure/images/...`
  request (via `RequestLoggingFilter`); cross-correlating with
  Worker logs by request ID (§D.4) is sufficient.

If we ever need real-time alerting on Worker events (e.g., burst of
401s on a specific token), the path is "Cloudflare Workers Logs ->
log-push to a SIEM" — set up at infrastructure layer, not via
backend webhook.

### D.2 Log levels — what the Worker MUST log

| Event | Level | Fields |
|---|---|---|
| Successful upload | INFO | `op=upload`, `key`, `bytes`, `contentType`, `userId` (from JWT `sub`/`uid`), `tokenJti` |
| Successful private GET | INFO | `op=view`, `key`, `chatId`, `userId`, `tokenJti` |
| Successful public GET | (none — too noisy; rely on access log) | — |
| Token expired (401) | INFO | `op`, `code=TOKEN_EXPIRED`, `tokenJti`, `keyAttempted` |
| Token signature invalid (401) | WARN | `op`, `code=TOKEN_SIGNATURE_INVALID`, `keyAttempted`, `ip` |
| Token scope mismatch (403) | WARN | `op`, `code=TOKEN_SCOPE_MISMATCH`, `expectedScope`, `actualScope`, `tokenJti` |
| Token key mismatch (403) | WARN | `op`, `code=TOKEN_KEY_MISMATCH`, `boundKey`, `attemptedKey`, `tokenJti` |
| Token already consumed, not idempotent (401) | INFO | `op`, `tokenJti`, `existingKey` |
| Token already consumed, idempotent return (200) | INFO | `op=upload`, `key`, `bytes`, `tokenJti`, `idempotent=true` |
| Content-type rejected (415) | INFO | `op=upload`, `code`, `tokenJti`, `presentedContentType` |
| Size exceeded (413) | INFO | `op=upload`, `code=FILE_TOO_LARGE`, `presentedBytes`, `maxBytes`, `tokenJti` |
| Path traversal (400) | WARN | `op`, `code=PATH_TRAVERSAL`, `keyAttempted` |
| Rate limited (429) | INFO | `op`, `code=RATE_LIMITED`, `tokenJti` (or `ip` if pre-token) |
| R2 write failure (500) | ERROR | `op=upload`, `key`, `r2Error` |
| Backend admin call (delete, etc., if added in §B.3) | INFO | `op=admin-*`, `actor=backend`, `keys` (truncated to 10 in log line; full count in field) |
| Auth header missing on admin path | WARN | `op=admin-*`, `code=BACKEND_AUTH_MISSING`, `ip` |
| Auth header invalid on admin path | WARN | `op=admin-*`, `code=BACKEND_AUTH_INVALID`, `ip` |

Pattern: WARN for security-relevant failures (signature invalid,
scope/key mismatch, path traversal, admin-auth fail). INFO for
expected user errors (token expired, content-type rejected, size
exceeded) and for successful operations.

### D.3 Log format — structured JSON

Worker MUST emit structured JSON via `console.log(JSON.stringify({...}))`
or the equivalent Workers logging API. Required keys on every log
line:

```json
{
  "ts": "2026-05-07T14:30:00.123Z",
  "level": "INFO",
  "op": "upload",
  "code": "OK",
  "requestId": "<x-request-id>",
  "userId": "<from-jwt-sub-or-null>",
  "tokenJti": "<from-jwt-jti-or-null>",
  "key": "<requested-or-bound-key-or-null>",
  "chatId": "<from-claims-or-null>",
  "bytes": 482301,
  "contentType": "image/jpeg",
  "ip": "<from-cf-connecting-ip>",
  "ua": "<from-user-agent-truncated>",
  "extra": { "any": "additional-context" }
}
```

Every field is nullable except `ts`, `level`, `op`, `code`,
`requestId`. Cloudflare Logs already ingests JSON cleanly.

### D.4 Request-ID echoing

**Backend wants this.** Frontend's §H.8 also asks for it. **YES on
the contract:**

- Worker generates an `x-request-id` (UUID v4) on every incoming
  request unless the caller provided one.
- Worker echoes the value in **every** response (success and error),
  in `x-request-id`.
- Worker logs the value in every log line.
- Backend logs the value when it receives a 4xx/5xx response from
  the Worker (the existing `RequestLoggingFilter` gets a small change
  to capture and propagate this).

This gives end-to-end correlation: frontend → backend (existing
`requestId` in MDC) → Worker (new `x-request-id`) → Cloudflare Logs.
Backend can emit a single log entry per upstream Worker failure with
both IDs. Support tickets can be traced.

---

## E. Error response format

### E.1 Confirm frontend's shape

Backend confirms the shape from
`IMAGE-PIPELINE-WORKER-NEEDS-FRONTEND.md` §C.2:

```json
{
  "error": {
    "code": "FILE_TOO_LARGE",
    "message": "Upload exceeds 10485760 bytes (received 14523891 bytes)",
    "details": { "max": 10485760, "received": 14523891 },
    "retryable": false
  }
}
```

`code` is the i18n key; `message` is for logs/dev; `details` is
optional structured context; `retryable` is a hint (frontend won't
blindly trust it for 4xx).

### E.2 Additional error codes backend wants

Only the admin-auth codes for the path described in §A.2:

| Code | HTTP | When |
|---|---|---|
| `BACKEND_AUTH_MISSING` | 401 | `X-Backend-Auth` header absent on an admin path |
| `BACKEND_AUTH_INVALID` | 401 | `X-Backend-Auth` value wrong |
| `BACKEND_PATH_NOT_FOUND` | 404 | Admin endpoint path matched no route (vs the public 404 which is `OBJECT_NOT_FOUND`) |

If the contract decides to add admin delete endpoints (§B.3), these
codes are used by them. If admin endpoints are left out of v1, only
the JWT-related codes from frontend §C.2 are needed.

### E.3 `x-request-id` in every response

Per §D.4. Mentioned here because it's also a contract requirement
on responses, not just an audit/logging concern.

### E.4 No verbose internal errors externally

For 5xx responses, the `message` field MUST be a generic English
sentence (e.g., `"R2 write failed"`) — the actual stack trace or
SDK error class name belongs in the Worker log, not the response
body. The `code` field carries the meaningful identifier.

### E.5 Localization concerns

Backend confirms frontend §C.3: **no `Accept-Language` handling on
the Worker.** Codes only. Backend doesn't render any of these
errors to end users either; they pass through to the frontend as
HTTP responses.

---

## F. CORS

### F.1 Backend → Worker is server-to-server

**No `Origin` header sent.** Spring's `RestTemplate` (used today by
`DefaultImageService:64`) does not set `Origin` by default. Verified
behavior: `RestTemplate` uses Java's `HttpURLConnection` under the
hood; `Origin` is a browser-only concept. Migration to `WebClient`
(if it happens) inherits the same default — no `Origin`.

If backend is ever observed sending `Origin` from a server-side
caller, that's a misconfiguration. The contract should specify that
the Worker MUST NOT echo the backend's `Origin` (if any) into
`Access-Control-Allow-Origin`. The `Access-Control-Allow-Origin`
allowlist serves browsers, not the backend.

### F.2 Backend explicitly does NOT need CORS allowance

- Backend's IP changes (single droplet today; could be a load
  balancer behind a private network later).
- The auth model for backend → Worker is `X-Backend-Auth`, not
  `Origin`-based.
- Adding the backend droplet's IP/origin to the CORS allowlist would
  be a mistake — it tells the Worker to honor browser preflights
  from server hosts, which makes no sense.

### F.3 Worker MUST NOT enable wildcard `Access-Control-Allow-Origin`

Per the spec's security requirements, no `*`. The Worker compares
the incoming `Origin` against the allowlist (frontend §D.1) and
echoes the matching origin only. Backend is not in this allowlist.

---

## G. Rate limits

### G.1 Backend → Worker: not rate-limited

The backend is a trusted server-to-server caller. Rate-limiting it
would harm the service when normal traffic spikes (e.g., a popular
listing causes many concurrent token issuances). The
`X-Backend-Auth` secret is the trust gate.

If we ever want to defend against a runaway backend bug
(e.g., infinite-loop calling the Worker), monitoring/alerting at the
Cloudflare side should catch this — not a hard rate limit on a
trusted caller.

### G.2 Per-token rate limits — Worker decides

Frontend's §C.1 has a `429 RATE_LIMITED` row. Backend agrees the
Worker should rate-limit:

- Per `tokenJti` (each upload token can be PUT-attempted at most
  ~5 times before the Worker rejects further attempts — this stops
  a leaked token from being used in a tight retry loop).
- Per source IP (defense against an attacker holding many leaked
  tokens at once).

Concrete numbers (e.g., 10 PUTs/sec per token, 100 PUTs/sec per IP)
are Worker-implementation details — frontend retry policy (§C.4)
already absorbs this without complaint as long as `Retry-After` is
honored.

Rate-limit state can live in Workers KV or Durable Objects — that's a
Worker-implementation choice; the contract just specifies the
behavior.

### G.3 Backend issuing tokens: rate-limit at the backend layer

Backend should rate-limit token issuance per (user, scope) at the
Spring layer, not on the Worker. We have `RateLimitFilter` and
Bucket4j wired up already (see CLAUDE.md / repo's
`security/ratelimit/`). Adding `/api/secure/images/upload-tokens`
to the rate-limit categories is a backend-internal change and not
part of the Worker contract. Mentioned here for completeness.

---

## H. JWT claims structure

### H.1 Final claims — backend's proposal

```json
{
  "iss": "oglasino-backend",
  "iat": 1730000000,
  "exp": 1730000600,
  "jti": "01J9X7KZQAF8M2NBAR3M0X5VHE",
  "sub": "<firebase-uid>",
  "scope": "upload",
  "kind": "product",
  "key": "public/products/abc-123.jpg",
  "contentType": "image/jpeg",
  "maxBytes": 10485760
}
```

For view tokens, `scope: "view"`, no `key`/`contentType`/`maxBytes`,
add `keyPrefix` and `chatId`:

```json
{
  "iss": "oglasino-backend",
  "iat": 1730000000,
  "exp": 1730014400,
  "jti": "01J9X7L4M2C9N0Q5T8V1W2H3K4",
  "sub": "<firebase-uid>",
  "scope": "view",
  "kind": "chat",
  "keyPrefix": "private/chats/abc-123/",
  "chatId": "abc-123"
}
```

### H.2 Per-claim rationale

| Claim | Why included |
|---|---|
| `iss` | Worker rejects tokens issued by anything other than `oglasino-backend`. Future-proof if we ever add a second issuer (admin tooling, automated jobs). |
| `iat`, `exp` | Standard JWT lifetime. `exp` derived from configurable TTL (frontend §G). |
| `jti` | Unique-per-token ID for log correlation, idempotency tracking, rate-limit keying, audit. ULID/UUID format. |
| `sub` | Firebase UID. Used by Worker for log enrichment only (no auth use — token signature already validated user). Lets logs answer "which user uploaded this." |
| `scope` | `"upload"` or `"view"`. Worker uses to gate which HTTP methods/paths are valid. |
| `kind` | `"product"` / `"profile"` / `"chat"` / `"report"`. Used by Worker to select the expected key prefix. Open enum. |
| `key` (upload only) | Exact full-key including prefix. Worker rejects PUT to any other key. |
| `contentType` (upload only) | Defense-in-depth: Worker rejects if PUT `Content-Type` header doesn't match. |
| `maxBytes` (upload only) | Per-token max size. Backend can issue different limits for different scopes (e.g., 5 MB for avatars, 10 MB for products). |
| `keyPrefix` (view only) | Path prefix granting access. Worker checks `requestedKey.startsWith(keyPrefix)` before serving R2 bytes. |
| `chatId` (view only) | Echoed for log enrichment. Not used for auth — `keyPrefix` is the gate. |

### H.3 What's deliberately NOT in the claims

- **No `aud`.** Single intended audience (this Worker); not worth the
  complexity. The `iss` check is sufficient gating.
- **No `nbf` (not-before).** All tokens are valid immediately on
  issuance.
- **No raw user email or display name.** PII minimization. `sub`
  (Firebase UID) is sufficient for log correlation; if support
  needs to map a UID to a person, the backend has that mapping.
- **No `roles`/`permissions`.** Worker only cares about scope/key
  — authorization decisions happen at backend issuance time.

### H.4 Header

```json
{
  "alg": "HS256",
  "typ": "JWT"
}
```

Backend won't use a `kid` (key ID) in v1. If we ever rotate the
JWT signing secret with a dual-key window (§I OQ-1), `kid` becomes
useful and would be added then.

### H.5 Size

A typical upload-token JWT is ~300 bytes encoded; well under URL
length limits even with the `?token=` pattern (private GETs use the
view JWT in query, which is ~250 bytes). No URL length issue.

---

## I. Open questions from frontend's document

Each addressed below with the prompt's requested
**YES / NO / COUNTERPROPOSAL** format.

### Q1 — Raw bytes vs `multipart/form-data`?

**Already RESOLVED in frontend doc** in favor of raw bytes.
Backend's confirmation: **YES, raw bytes.**

Today's Worker accepts both per the spec's "current state"; the
backend doesn't observe the wire format directly (it's between
client and Worker). New contract should be tightened to raw bytes
only — drops Worker complexity (no multipart parser).

Backend has no implementation impact from this — it doesn't proxy
bytes today and won't in the new contract.

### Q2 — Database migration: store full key (with prefix) or raw UUID?

**YES — store full key with prefix in DB.** Largest backend impact
in the contract; rationale and concrete entity-level changes in
§C.1.

Migration: not needed (pre-prod data is disposable — see
[DB-RESET-RUNBOOK.md](../../docs/DB-RESET-RUNBOOK.md)). The migration
**does** require a one-time correction in the source seed data,
because some sample products in `data/` may have bare UUIDs as
imageKeys — TBC by the implementing PR.

### Q3 — Magic-byte sniffing on upload?

**COUNTERPROPOSAL: NO for v1, design the contract so YES is
additive later.**

Reasoning:

- Frontend already does client-side processing (Track 4) which
  produces genuinely-image bytes from a known library; the only
  attack vector is a malicious client that bypasses the frontend
  and PUTs arbitrary bytes against a stolen token.
- A stolen upload token is bound to a specific `key` and
  `contentType`; the worst an attacker can do is overwrite that
  exact key with garbage. Cloudflare Image Resizing on the read
  side will fail to render and return an error response, not serve
  malformed bytes — so the blast radius is one image entry until
  the user re-uploads.
- Magic-byte sniffing requires the Worker to buffer the first
  ~12 bytes of every upload before deciding to stream to R2; that's
  small overhead but adds error paths on every upload.

Backend's view: defer until we have evidence of abuse. The contract
should allow adding the check later without changing the wire shape
(it's a Worker-internal validation step). Frontend agreed it's a
"defense-in-depth" item, not a load-bearing one.

If the contract author overrules and chooses YES: rejected uploads
should return `415 CONTENT_TYPE_NOT_ALLOWED` (existing code) with
`details: { reason: "magic-byte-mismatch" }`.

### Q4 — Idempotent retry on already-consumed tokens?

**Already RESOLVED in frontend doc** in favor of YES (Worker does
`R2.head()` on every PUT and returns the existing object's metadata
on duplicate). Backend confirms.

Implementation impact for backend: **none.** The idempotency
behavior is entirely Worker-internal; the backend's view is "client
sent the same token twice; Worker handled it gracefully."

Performance footnote: the `head()` is cheap (R2 metadata, no body
transfer) and only runs on PUT, which is uncommon compared to GET.

### Q5 — Worker timeout for large uploads?

**COUNTERPROPOSAL: design and verify, don't pre-emptively over-engineer.**

The 30s Workers CPU limit doesn't apply to body streaming (only to
JS execution time). R2 `put()` streams; the Worker's CPU during a
10MB upload is a few ms total. The wall-clock concern is the
Cloudflare subrequest limit (which is generous for streamed uploads
to first-party R2).

Backend's view:

1. Set a sensible client-side timeout (frontend §H.4 says ~2 min) —
   that bounds the wall clock from one end.
2. Test against a 10 MB upload over a slow connection during
   implementation (Track 0 deployment).
3. If tests fail, we can split into a TUS-style resumable upload
   later (additive, not a contract break). This is unlikely.

The contract author can document "Worker SHOULD complete within 2
minutes; client SHOULD time out at 2 minutes" as the agreed budget.

### Q6 — Variant URLs and watermark logo fetch?

**YES** — `public/brand/` is unauthenticated read. Confirmed.

The `public/brand/logo-watermark.png` is a static asset Cloudflare
Image Resizing fetches when applying the `draw=` parameter. The
Worker must allow `GET` to this path without a token (same rule as
all `public/*` keys).

No backend involvement — backend doesn't seed `public/brand/` files;
they're uploaded once by an operator (manual `aws s3 cp` or
equivalent) and treated as immutable.

### Q7 — Profile picture path: `public/profiles/` or `public/products/`?

**YES, split into `public/profiles/`.** Backend's preference, per
§C.3.

Reasons:

- Cleaner — query-by-prefix (`public/profiles/`) is straightforward
  for any future cleanup utility.
- Per-domain quotas / rate-limits are easier when the path
  distinguishes them.
- Different watermark policies (none on profiles vs hero on
  products) are easier when the read URL identifies the kind.

The cost: backend's upload-token endpoint distinguishes `kind:
"product"` vs `kind: "profile"` (already reflected in the JWT claims
in §H.1) and assigns the prefix accordingly. Trivial.

### Q8 — HEIC support timeline?

**YES — keep `image/heic` and `image/heif` in `ALLOWED_CONTENT_TYPES`
for v1.** Per backend's read of the multi-client lens (§K).

The backend doesn't decide when web vs RN ships HEIC conversion —
that's two different frontend release cadences. Worker keeps the
allowlist broad until **both** clients confirm HEIC conversion is
production-default; only then can the contract author tighten it
(without a code change, just an env var update on the Worker).

The contract should specify that `ALLOWED_CONTENT_TYPES` is an
operator-flippable env var on the Worker, **not** baked into the
contract itself. That way the tightening is a deploy, not a
contract revision.

### OQ-1 — JWT signing-secret rotation strategy

Not in the prompt's open questions, but a backend concern: how do we
rotate `JWT_SIGNING_SECRET` without an outage?

**Backend's proposed approach:**

1. Configure the Worker with two env vars: `JWT_SIGNING_SECRET` and
   optional `JWT_SIGNING_SECRET_PREVIOUS`.
2. On verify, try the current secret first; on signature fail, try
   the previous (if present).
3. Backend signs new tokens with the current secret only.
4. To rotate: deploy current → previous, deploy new → current,
   wait one full TTL window, then drop previous.

Add `kid` to the JWT header at that point so we don't blindly try
both secrets (faster verify, cleaner logs). Until rotation is
needed, `kid` is omitted to keep the contract minimal.

### OQ-2 — Backend's view-token endpoint membership check

Per audit defect §9 #4, today the backend doesn't verify chat
membership before issuing a view token; the Worker historically did
that check. In the new contract:

- The Worker has no Firestore access.
- The backend has Firestore access via `DefaultFirebaseChatService`.
- Therefore: backend MUST verify membership before signing a view
  JWT.

This is a backend-implementation change, not a Worker contract
clause. Flagging here so the implementing PR doesn't miss it. (The
membership-check call is read-only against Firestore; cost is
trivial.)

### OQ-3 — Multi-image upload tokens: one JWT per image

Every implementation choice in this contract has assumed `count` ≥ 1
returns an array of N tokens (each bound to a single key). Frontend
§A.1 locks this in. Backend confirms: **one JWT per image**, no
shared/reusable tokens. The blast radius / replay-protection
argument is sound.

### OQ-4 — Should the contract specify Worker source repo location?

The audit (§7) confirms the Worker source code is **not** in this
backend repo, and there's no record in this repo of where it lives.
Before Phase B (implementation), the contract author should record
the Worker repo URL, branch model, and deployment owner in the
unified contract. Otherwise Track 0 has nowhere to land.

---

## J. Backend names the frontend's `{backend-defined-endpoint}` placeholders

Frontend used placeholders throughout. Backend names them now:

| Placeholder used by frontend | Backend's chosen path | Method | Replaces today's |
|---|---|---|---|
| Upload-token batch endpoint | `POST /api/secure/images/upload-tokens` | POST | `/api/secure/direct-upload`, `/api/secure/direct-upload-batch` |
| View-token endpoint | `POST /api/secure/images/view-tokens` | POST | `/api/secure/view-token` |

Notes on the rename:

- Plural (`upload-tokens`, `view-tokens`) — both endpoints return
  N≥1 tokens. The single-token endpoint at
  `/api/secure/direct-upload` is collapsed into the batch endpoint
  with `count: 1`.
- `/api/secure/images/...` — namespaces image operations under
  `images/`, leaving room for future image-related endpoints
  (admin, audit, etc.) without polluting the top of `/api/secure/`.
- Both endpoints take a Firebase JWT in `Authorization: Bearer ...`,
  per existing `/api/secure/**` auth model.
- Both endpoints are subject to the `RateLimitFilter` in a new
  `IMAGE_TOKEN_ISSUANCE` rate-limit category (per-user budget,
  e.g., 60 tokens/min).

### J.1 Request/response shapes

#### `POST /api/secure/images/upload-tokens`

Request:

```json
{
  "scope": "product",
  "count": 3,
  "contentTypes": ["image/jpeg", "image/jpeg", "image/jpeg"],
  "chatId": "abc-123"
}
```

- `scope`: `"product" | "profile" | "chat" | "report"` (open enum).
- `count`: 1–5.
- `contentTypes`: array length must equal `count`. Per frontend
  §A.1, MIME is encoded into each token.
- `chatId`: required when `scope === "chat"`, otherwise omitted.

Response (200):

```json
{
  "tokens": [
    {
      "token": "<JWT-HS256>",
      "key": "public/products/uuid-1.jpg",
      "uploadUrl": "https://cdn.oglasino.com/public/products/uuid-1.jpg",
      "expiresAt": "2026-05-07T14:30:00Z"
    }
  ]
}
```

Errors (400) for invalid scope, count out of range, contentType
not allowed, chatId missing where required, etc. — backend-side
errors, separate from Worker error codes.

#### `POST /api/secure/images/view-tokens`

Request:

```json
{
  "scope": "chat",
  "chatId": "abc-123"
}
```

Response (200):

```json
{
  "token": "<JWT-HS256>",
  "expiresAt": "2026-05-07T18:30:00Z",
  "scope": "chat",
  "chatId": "abc-123"
}
```

Errors: 400 if scope unsupported, 403 if user not a member of
`chatId` (per OQ-2), 401 if not authenticated.

### J.2 Migration of existing endpoints

The four existing endpoints (`/api/secure/direct-upload`,
`/direct-upload-batch`, `/view-token`, plus implicit Worker
`/api/{accountId}/get-token` and `/get-view-token`) can be retired
in **two phases**:

1. Backend ships the new endpoints alongside the old ones; old ones
   continue to call today's Worker. Both sets work for one release
   window.
2. Frontend (web + RN) migrate to the new endpoints. After the
   slowest client cuts over, the old endpoints + old Worker
   endpoints are deleted in a single PR.

Or — given the spec says we're pre-prod with disposable data — do
the cutover in one PR. Up to the implementing agent / project
plan.

---

## K. Multi-client considerations from backend's perspective

The contract is consumed by both Next.js web and React Native
iOS/Android. The backend's posture:

- **Backend treats web and RN identically.** Both clients send
  Firebase ID tokens, both call the same `/api/secure/images/...`
  endpoints, both get the same JWT issued back. There is no
  platform-specific endpoint in the backend's image surface.
- **Firebase JWT verification works for all clients.** Firebase
  Admin handles the token verification regardless of which client
  SDK issued the ID token. No backend changes needed for RN.
- **No platform-specific business logic in the image stack.**
  Backend's only job is "verify the user, sign a JWT, return it."
  The user's platform doesn't enter the decision tree.

The backend is unaware of:

- Whether `User-Agent` says iOS/Android/Chrome/Safari.
- Whether the client did HEIC conversion or not (the JWT carries
  the eventual content-type, the Worker enforces it).
- Whether the client uses XHR/fetch/native — the backend just hands
  back a JWT and doesn't watch the upload.

**Confirmed: backend has no platform-specific logic on the image
path.**

The only platform consideration the contract should bake in is
HEIC tolerance (§I Q8): the Worker must accept HEIC for v1 because
RN may take longer than web to ship client-side conversion. That's
a Worker `ALLOWED_CONTENT_TYPES` env value, not backend-side.

---

## L. Anything else

### L.1 Edge cases the backend has thought of

- **Upload token issuance during Firebase outage.** The
  `FirebaseAuthFilter` would reject the request at auth time
  (existing behavior); no token is issued. No image-stack-specific
  handling needed.
- **JWT issued, user deauthenticates seconds later.** The JWT
  remains valid until its `exp` (≤10 min for upload, ≤4h for view).
  This is a deliberate trade-off — short TTLs limit the window.
  No revocation list in v1.
- **Backend restart while upload tokens are in flight.** Tokens are
  stateless (no DB lookup on the Worker side), so backend restart
  has zero effect on outstanding tokens. They remain valid until
  expiry.
- **Worker is healthy but R2 is having issues.** Worker returns
  `500 R2_WRITE_FAILED`; frontend retries per §C.4; if persistent,
  user sees the standard error UI. Backend not involved on this
  path (it's client → Worker → R2).
- **Concurrent edits to a product creating image-key races.** The
  product's image-keys are a `Set<String>` in the entity; concurrent
  PATCH requests would last-writer-wins. This isn't an image-stack
  concern, it's a product-update concurrency concern; existing
  behavior preserved.

### L.2 Existing infrastructure constraints affecting contract design

- **`RestTemplate` in `DefaultImageService` is fine for one
  HTTPS call to a Cloudflare-hosted Worker.** Connection pooling,
  retries, and timeouts default to Java's `URLConnection` defaults.
  When the new backend endpoints are written, consider switching
  to `WebClient` (already a Spring dependency in `webflux`
  starter — `pom.xml`) for better timeout/retry support. **Not a
  contract concern**, just a quality-of-life nit.
- **Bucket4j is already wired** for rate-limiting at the
  `/api/secure/...` layer. Adding a new rate-limit category for
  token issuance is a small change.
- **Spring Security's default no-cache headers apply to all
  `/api/secure/**` responses.** That's fine — token-issuance
  responses shouldn't be cached anyway. Consistent with existing
  posture documented in
  [docs/04-database-overview.md](../../docs/04-database-overview.md)
  (peripheral context).
- **MDC propagation** — existing `RequestLoggingFilter` populates
  MDC with `requestId`, `userId`, `clientIp`. The new image
  endpoints inherit this for free. The new `x-request-id` header
  echoed by the Worker (§D.4) lets us cross-correlate; backend's
  logging filter needs a small change to capture the response
  header on outgoing Worker calls.

### L.3 Spec items the backend disagrees with — flag for reconciliation

- **Spec calls for `Worker /api/{accountId}/get-token` to remain.**
  In the new contract, the Worker has no token-issuance endpoint
  at all (per the prompt's clarification: backend signs, Worker
  verifies). The spec's "Current state" descriptions are just
  describing today's state, not the target. **No actual
  disagreement** — flagging in case the contract author is reading
  spec-target language and confused.
- **Spec mentions "issue token via Worker."** The new contract
  consolidates token issuance to the backend. Worker has zero
  knowledge of users, chats, or products. **Backend's preference
  is unambiguous** and matches frontend §B.3.
- **Spec's Track 4 requires HEIC conversion on web AND RN.** We
  cannot drop HEIC from the Worker allowlist until both clients
  ship conversion — and "ship" includes a release across all
  current users (not just a deployed build). This is a multi-month
  window; the Worker contract should not assume a date. See §I Q8.

### L.4 Open questions for product/architecture decisions

Final list — items needing a human call before contract
reconciliation:

| OQ | Question | Backend's lean |
|---|---|---|
| **OQ-1** | JWT signing-secret rotation strategy: dual-key window or hard cutover? | Dual-key window; add `kid` claim when rotation is real |
| **OQ-2** | Backend MUST verify chat membership before signing view JWT — confirm wire change to existing `view-token` endpoint | Yes — fix today's gap (audit §9 #4) |
| **OQ-3** | Worker repo location and ownership — record before Phase B | Record explicitly; without this Track 0 stalls |
| **OQ-4** | Are we routing deletes through the Worker (audit logs unification) or keeping direct R2 (simplicity)? | Direct R2 |
| **OQ-5** | `count` upper bound on `/upload-tokens` — frontend caps at 5, backend enforces same? | Yes, 5; tighten if abuse appears |
| **OQ-6** | Should `kind: "review"` be its own scope/prefix in v1, or piggyback on `"product"`? | Piggyback for v1; revisit when reviews need separate retention |
| **OQ-7** | Public profile picture privacy considerations — should profiles ever be private? | Public for v1 (matches today); revisit for paid-tier features |
| **OQ-8** | The seven existing-code defects in audit §9 — fix in this PR or follow-up? | Fix #1 (broken cleanup job) in this PR; defer the rest |

---

**End of backend's input.** Awaiting consolidated unified Worker
contract from Igor before Phase B (Worker implementation).
