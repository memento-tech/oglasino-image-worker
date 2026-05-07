# Image Pipeline — Worker Contract: Frontend Requirements

**Owner:** Frontend agent
**Status:** Draft for consolidation into unified Worker contract
**Last updated:** 2026-05-07
**Companion docs:** `jobs/image_pipeline/IMAGE-PIPELINE-SPEC.md` (master spec), `jobs/image_pipeline/IMAGE-PIPELINE-WORKER-NEEDS-BACKEND.md` (peer)

---

## 0. Purpose and scope

This document captures **what the frontend needs from the new Cloudflare Worker** so that the unified Worker contract can be drafted. It is **not** an implementation plan, **not** a backend spec, and **not** a description of current behavior except where a current behavior establishes a constraint or precedent the frontend wants kept.

The contract is consumed by **two client codebases**: the Next.js web frontend and the React Native iOS/Android app. Both run JavaScript and share the vast majority of contract concerns. Differences are called out where relevant; see §K for the consolidated multi-client view.

If anything below conflicts with backend's needs, that's a reconciliation point — not an error.

### 0.1 Anchor: how the frontend talks to the Worker today

Captured here verbatim so the contract authors know the starting point. Source files cited inline. (Web codebase only — RN flows are equivalent in shape.)

| Operation | Today's caller | Today's endpoint | Today's headers / body | Today's response |
|---|---|---|---|---|
| Get upload token (single) | `uploadToCloudflare` in `src/lib/service/reactCalls/cloudflareService.ts:30-43` | `POST {BACKEND_API}/secure/direct-upload` | Bearer Firebase JWT + cookies | `{ token: string, key: string }` |
| Get upload tokens (batch, N) | `uploadBatchParallel` / `uploadChatImagesBatchParallel` in `cloudflareService.ts:46-90` | `POST {BACKEND_API}/secure/direct-upload-batch` | body: `{ count, chatId? }` | `Array<{ token, key }>` |
| Upload bytes | `uploadToCloudflareInternal` in `cloudflareService.ts:110-139` | `PUT ${WORKER_URL}/${folder}${key}` | header `x-upload-token: <token>`, body: `FormData` with `file` field | `{ fileName: string }` |
| Get chat view token | `getViewChatImagesToken` in `cloudflareService.ts:92-104` | `POST {BACKEND_API}/secure/view-token` | body: `{ chatId }` | `{ token: string }` |
| Display public image | `getImageForKey` in `cloudflareService.ts:21-23` | `GET ${WORKER_URL}/${key}` (direct, no token) | — | image bytes |
| Display chat image | `getChatImageForKey` in `cloudflareService.ts:25-26` | `GET ${WORKER_URL}/chat-images/${chatId}/${key}?token=${viewToken}` | — | image bytes |

`WORKER_URL` is `process.env.NEXT_PUBLIC_CDN_URL` on web (set in `.env.local.example` to `https://cdn.oglasino.com`). RN configures the equivalent value via its own build env.

The frontend is happy with the **shape** of this flow — token-from-backend, single PUT to Worker, signed URL for private — and asks the contract to preserve it with the changes documented below.

---

## A. Upload flows

The frontend distinguishes four upload kinds. v1 ships (1)–(3); (4) is documented here only so the contract is forward-compatible.

### A.1 Common upload contract (applies to every kind)

The frontend's standing position on every upload flow:

| Decision | Frontend preference | Why |
|---|---|---|
| Where the upload token is issued | **Backend-issued.** Frontend never calls Worker directly for tokens. | Backend already has `Authorization: Bearer <firebase-jwt>` and can verify "is this user allowed to upload to *this* chat / their *own* avatar / a *new* listing draft." Worker should not have to re-verify user identity — it just trusts a backend-signed token. |
| Token cardinality | **One image per token.** Batch endpoints return *N tokens* for *N files*, never one reusable token. | Smaller blast radius if a token leaks. Easier auditing. Matches today's batch shape. |
| Token reusability | **Single use.** A token consumed by a successful PUT becomes invalid. A failed PUT (network error before bytes arrived, 5xx from Worker) **may** be retried with the same token until expiry — see §C.4 and §I Q4. | Simple mental model; replay attacks limited. |
| Token format | **JWT (HS256)** with a backend↔Worker shared secret. | Standard format, parseable by web and React Native using the same JavaScript JWT library. Bespoke HMAC payload would require custom code on each platform. Headers/claims are typed and self-documenting. |
| Upload protocol | **Single PUT with raw bytes** as request body. No multipart, no chunked, no resumable. | Simplest wire format; works identically for web `fetch` and RN `fetch`. No multipart parsing in Worker. |
| Auth header on PUT | **Only `x-upload-token`**. No Firebase JWT, no cookie. | The token *is* the auth. Token == capability. CORS preflights stay simple (web only). |
| Response body shape | **Structured JSON** with full key (with prefix), bytes, content type. See §A.6. | Today's response is `{ fileName }` which is ambiguous; frontend wants the canonical thing it should store in the database. |

### A.2 Product image upload (v1)

**Trigger.** User opens "Create product" / "Edit product" dialog, selects up to 5 images via the `ImagesImport` component (`src/components/client/ImagesImport.tsx`), then submits the product form. RN equivalent uses the platform image picker.

**What frontend knows at token-request time:**
- The current Firebase user (always — uploads are gated behind login)
- That the destination is a product image
- **No** product/listing ID yet — the listing is created *after* images upload, then the returned keys are sent to backend in the create-product payload
- The number of images being uploaded (1–5)

**Token-request request shape (frontend → backend):**

```
POST {backend-defined-endpoint}
Authorization: Bearer <firebase-jwt>

{
  "scope": "product",
  "count": 3,
  "contentTypes": ["image/jpeg", "image/jpeg", "image/jpeg"]
}
```

(Backend names its own endpoint path. Frontend only constrains the request body and response body shapes.)

**Response:**

```ts
type UploadTokenBatch = {
  tokens: Array<{
    token: string;          // JWT (HS256); frontend treats as opaque bearer
    key: string;            // FULL key including prefix, e.g. "public/products/{uuid}.jpg"
    uploadUrl: string;      // ready-to-PUT URL (Worker hostname + path)
    expiresAt: string;      // ISO-8601 timestamp; frontend uses this to early-fail expired tokens
  }>;
};
```

The frontend sends `contentTypes` per file so backend / Worker can encode the MIME into the issued token (defense-in-depth: Worker rejects PUT if the `Content-Type` header doesn't match what the token was issued for).

**PUT to Worker:**

```ts
await fetch(uploadUrl, {
  method: 'PUT',
  headers: {
    'x-upload-token': token,
    'Content-Type': processedFile.type, // image/jpeg, image/png, image/webp
  },
  body: processedFile, // raw bytes (Blob on web, equivalent on RN)
  signal: abortController.signal,
});
```

**Response (success):** see §A.6.

**What frontend stores back to backend:** the `key` (with prefix). The product-create payload changes from today's `imageKeys: ["uuid-1", "uuid-2"]` (raw UUIDs) to `imageKeys: ["public/products/uuid-1.jpg", "public/products/uuid-2.jpg"]` (full keys). This is a deliberate breaking change versus today and must be coordinated with backend (§I Q2).

### A.3 Profile picture upload (v1)

**Trigger.** User opens `/owner/user`, uploads via `AvatarUpload` (`src/components/owner/client/AvatarUpload.tsx`) on web, or the equivalent RN profile screen, saves.

**What frontend knows:** Firebase user, scope = profile picture, count = 1.

**Token-request shape:**

```
POST {backend-defined-endpoint}
Authorization: Bearer <firebase-jwt>

{
  "scope": "profile",
  "count": 1,
  "contentTypes": ["image/jpeg"]
}
```

**Differences from product upload:**
- `scope: "profile"`
- `count: 1` always
- The returned `key` will use a different prefix — the spec leaves it open whether avatars go under `public/profiles/{uuid}.{ext}` or stay under `public/products/` for v1; frontend can handle either as long as the key is returned with prefix.

Otherwise identical to A.2.

### A.4 Chat attachment upload (v1)

**Trigger.** User clicks the image icon in `MessageInput` (`src/messages/components/MessageInput.tsx`) on web, or the RN equivalent, selects up to 5 images, sends the message.

**What frontend knows:**
- Firebase user
- The active `chatId` (always — you can't be in MessageInput without an open chat)
- That this is a chat attachment (private)
- Count: 1–5

**Token-request shape:**

```
POST {backend-defined-endpoint}
Authorization: Bearer <firebase-jwt>

{
  "scope": "chat",
  "chatId": "abc-123",
  "count": 2,
  "contentTypes": ["image/jpeg", "image/png"]
}
```

**Token binding requirement:** the issued token MUST be bound to (`chatId`, `key-prefix`). Worker rejects PUT to any path not under `private/chats/{chatId}/`.

**Returned `key` shape:** `private/chats/{chatId}/{uuid}.{ext}` — full path with prefix.

**Storage in DB:** the message body stores the full key (with prefix). Frontend currently stores raw UUID; this changes to full key (§I Q2).

### A.5 Future: report image upload (v2, NOT in v1)

Documented so the contract isn't accidentally locked into product/chat-only thinking.

**Anticipated shape:**

```
POST {backend-defined-endpoint}
{
  "scope": "report",
  "reportId": "...",
  "count": 1,
  "contentTypes": ["image/jpeg"]
}
```

Returned `key` shape: `private/reports/{reportId}/{uuid}.{ext}`. Same auth model as chat. Frontend asks the contract to make `scope` an open enum so adding `"report"` later does not require a contract change.

### A.6 Upload response — what frontend wants back

For every successful PUT, the frontend wants:

```ts
interface UploadResponseBody {
  /** Full key with prefix. ECHOes what was issued in the token. Source of truth for what to store in DB. */
  key: string;

  /** Bytes actually written. Sanity-check against the file the frontend sent. */
  bytes: number;

  /** Echo of accepted Content-Type. Sanity-check the Worker honored what frontend sent. */
  contentType: string;
}
```

The frontend (and RN) construct display URLs from `key` using their own client-side CDN base URL. Worker does **not** need to know its own CDN hostname or return ready-to-render URLs — that's a client-side concern. Backend may use `bytes` and `contentType` for audit logs.

### A.7 Cancelation, retry, abort

| Scenario | Frontend behavior | What frontend needs from Worker |
|---|---|---|
| User clicks "Cancel" mid-upload | Calls `AbortController.abort()` on the PUT | Worker should return cleanly on aborted connection (no orphan R2 objects). Idempotency key: the `key` is fixed by the token, so a retry uses the same key (no duplicates). |
| Network error mid-upload | Retry up to 2× with exponential backoff (1s, 4s) using **the same token** | Token must remain valid until its `expiresAt`, even after a 5xx or aborted PUT. Once a 2xx is returned, the token is consumed (subject to §I Q4 idempotent-retry resolution). |
| Browser tab / app closed before PUT completes | Token expires unused → R2 has no object → no orphans | Worker writes to R2 only on successful completion of PUT body. |
| Token expired before PUT | Frontend gets 401, calls token endpoint again, retries once with new token | Worker returns `{ "error": { "code": "TOKEN_EXPIRED" } }` (see §C.2) so frontend knows it's safe to re-request a token. |
| User uploads same image twice in same session | Frontend dedupes via SHA-256 hash before requesting tokens (existing behavior, `productValidator.ts:229-236`) | No Worker-side dedup needed in v1. |

---

## B. Display flows

### B.1 Public images (products, profile pictures)

**No token needed.** Frontend constructs URLs directly:

```ts
// src/lib/images/variants.ts (NEW MODULE on web — does not exist today; RN has its equivalent)

const CDN_BASE = process.env.NEXT_PUBLIC_CDN_URL!; // web — RN reads from its own env config

export type PublicVariant = 'card' | 'hero' | 'original';

const VARIANT_PARAMS: Record<Exclude<PublicVariant, 'original'>, string> = {
  card: 'width=400,height=300,fit=cover,format=auto,quality=85',
  hero: 'width=1600,height=1200,fit=scale-down,format=auto,quality=85',
  // hero will gain a `draw=...` watermark param in Track 3
};

export function publicImageUrl(key: string, variant: PublicVariant = 'card'): string {
  if (variant === 'original') return `${CDN_BASE}/${key}`;
  return `${CDN_BASE}/cdn-cgi/image/${VARIANT_PARAMS[variant]}/${key}`;
}
```

**What this requires from Worker:**

1. The Worker MUST allow unauthenticated `GET` to any key starting with `public/`.
2. The Worker MUST NOT interfere with the `/cdn-cgi/image/...` prefix — Cloudflare Image Resizing intercepts those requests at the edge before the Worker runs. The Worker only sees post-resize requests for the underlying R2 object.
3. The Worker MUST return correct `Cache-Control` headers on public images so the edge caches transformed variants:
   - `Cache-Control: public, max-age=31536000, immutable` (UUID keys are content-addressed; new content gets new key).
4. The Worker MUST set `Vary: Accept` so `format=auto` works (different bytes for Chrome vs Safari).
5. The Worker MUST return `404` for missing keys, never `403` (avoid leaking existence info).

### B.2 Private images (chat attachments)

**Token required, attached as query param.**

Frontend URL construction:

```ts
export function chatImageUrl(chatId: string, key: string, viewToken: string): string {
  return `${CDN_BASE}/${key}?token=${encodeURIComponent(viewToken)}`;
  // key already contains "private/chats/{chatId}/..." prefix
}
```

**Token lifecycle on the frontend (today's behavior, target behavior):**

| Today (`MessageImages.tsx:24-49`) | Target (with longer TTL) |
|---|---|
| Fetched in `useEffect` on chat open. Stored in component-local React state. Refetched on `<img onError>` up to 2 retries. | Fetched on chat open. Cached in a Zustand store keyed by `chatId` with `expiresAt`. Refreshed proactively before expiry. Retry on 401 once, then surface error. RN uses an equivalent in-memory cache. |

**What the frontend needs from Worker for private images:**

1. **Long TTL.** Today's 10-minute TTL is too short — a user can scroll a long chat for hours. Frontend wants **at least 1 hour, prefers 4 hours.**
2. **Same-token-for-all-images-in-chat.** One view token grants access to every image in a single `chatId` for the token's TTL. Frontend should not have to maintain a per-image token cache.
3. **Token in query string only.** Not a header — `<img src>` (web) and RN `<Image source={{ uri }}>` cannot carry headers. Tokens may appear in Referer; frontend will set strict referrer policy on web; Worker should still treat tokens as short-lived.
4. **Clear 401 on expiry.** Frontend re-requests a fresh token on 401 and retries the image once.
5. **No directory listing.** A `GET /private/chats/{chatId}/` (no key) must NOT return a list of objects. Return 404.
6. **Path traversal rejection.** `..`, absolute paths, URL-encoded path tricks → 400. Frontend will not send these but defense in depth.

**View-token request shape:**

```
POST {backend-defined-endpoint}
Authorization: Bearer <firebase-jwt>

{
  "scope": "chat",
  "chatId": "abc-123"
}
```

**Response:**

```ts
interface ViewTokenResponse {
  token: string;           // JWT (HS256)
  expiresAt: string;       // ISO-8601 — frontend uses this to schedule proactive refresh
  scope: 'chat';
  chatId: string;          // ECHO for sanity
}
```

### B.3 Why the frontend prefers tokens via backend (not direct to Worker)

Restating because it's load-bearing:

- Backend already has the user's Firebase JWT and can verify chat membership (a chat-membership check requires querying the chat-participants table — Worker shouldn't replicate this).
- Backend can rate-limit token issuance per user.
- Backend can audit who is requesting access to what private content.
- Worker only needs to verify "this token was signed by our backend's HS256 secret AND has not expired AND is bound to this chatId/key-prefix" — much simpler.

The Worker therefore needs:
- A shared secret with backend for JWT (HS256) verification.
- No knowledge of users, chats, or product ownership.

### B.4 No view-token caching across page loads / app launches

The frontend deliberately does NOT plan to persist view tokens to `localStorage`, cookies, or RN secure storage. Reasons:
- Tokens are short-lived enough that re-fetching is fine.
- Avoids token-leaked-through-storage-XSS attack class.
- Simplifies the mental model.

In-memory cache (Zustand on web; RN equivalent state container) only. This means the contract should ensure the token-issuance endpoint is fast (single round trip, no DB joins beyond chat-membership check).

---

## C. Error handling

### C.1 HTTP status codes the frontend distinguishes

The frontend wants a clean mapping from status code to user-facing UX. Each status MUST be returned for exactly the situation listed. No bundling unrelated failures into the same code.

| Status | Frontend treatment | When Worker should return it |
|---|---|---|
| **200 / 201** | Success | PUT completed, bytes written, R2 confirmed. |
| **400 Bad Request** | Show `tErrors('image.invalid')` inline. Do not retry. | Malformed request: missing token header, malformed token, path traversal in key, body not a valid image (if Worker checks magic bytes — see §I Q3). |
| **401 Unauthorized** | For PUT: re-request a new upload token, retry **once**, then surface generic error. For GET (private): re-request view token, swap source URL, retry once, then show broken-image fallback. | Token expired, token signature invalid, token bound to a different scope/key. |
| **403 Forbidden** | Show `tErrors('image.forbidden')`. Do **not** retry. | A valid token used for a path it isn't bound to (e.g., chat-A token used for chat-B image). |
| **404 Not Found** | For GET: show broken-image fallback. For PUT: this should never happen (Worker creates the key) — treat as 5xx. | Key doesn't exist in R2. |
| **413 Payload Too Large** | Show `tErrors('image.too.big')` (key already exists). Do not retry. | PUT body exceeds Worker-enforced max (10 MB). |
| **415 Unsupported Media Type** | Show `tErrors('image.bad.format')` (NEW key). Do not retry. | `Content-Type` not in allowlist, or Content-Type header doesn't match the type encoded in the token. |
| **429 Too Many Requests** | Show `tErrors('image.rate.limited')` (NEW key). Retry after `Retry-After` header (default 5s, max 30s) up to 1 time. | Per-IP or per-user rate limit hit. |
| **500–599 Server Error** | Retry up to 2× with backoff (1s, 4s). After exhausted, show `tErrors('image.server.error')` (NEW key). | Unexpected Worker / R2 failure. |

### C.2 Error response body — required JSON shape

Every non-2xx response MUST be `application/json` with this body (parses identically on web `fetch().json()` and RN `fetch().json()`):

```ts
interface WorkerErrorResponse {
  error: {
    code: string;              // STABLE identifier — frontend keys i18n off this. SCREAMING_SNAKE_CASE.
    message: string;           // English, for logs and dev tools. NOT shown to users.
    details?: Record<string, unknown>; // optional structured context for backend logging
    retryable: boolean;        // explicit flag — saves frontend from inferring from status
  };
}
```

**Required `code` values for v1** (Worker MUST emit these strings; frontend keys i18n off them):

| Code | Status | Meaning |
|---|---|---|
| `TOKEN_MISSING` | 400 | No `x-upload-token` header on PUT, or no `?token=` on private GET |
| `TOKEN_MALFORMED` | 400 | Token doesn't parse |
| `TOKEN_EXPIRED` | 401 | Token's exp < now |
| `TOKEN_SIGNATURE_INVALID` | 401 | HMAC / signature verification failed |
| `TOKEN_SCOPE_MISMATCH` | 403 | Token bound to scope X, used on scope Y |
| `TOKEN_KEY_MISMATCH` | 403 | Token bound to key A, used to PUT key B |
| `TOKEN_ALREADY_CONSUMED` | 401 | Single-use token reused after success (subject to §I Q4 idempotent-retry resolution) |
| `CONTENT_TYPE_NOT_ALLOWED` | 415 | Type not in allowlist |
| `CONTENT_TYPE_MISMATCH` | 415 | Type doesn't match what token was issued for |
| `FILE_TOO_LARGE` | 413 | Bytes exceed `MAX_UPLOAD_BYTES` |
| `PATH_TRAVERSAL` | 400 | `..` or absolute path detected |
| `RATE_LIMITED` | 429 | Plus `Retry-After` header |
| `OBJECT_NOT_FOUND` | 404 | GET for missing R2 key |
| `R2_WRITE_FAILED` | 500 | PUT succeeded validation, R2 write failed |
| `INTERNAL` | 500 | Catch-all unexpected |

### C.3 Localization: codes, not server-rendered messages

Frontend's preference (matches the spec):
- Worker returns **codes** (English `message` is for logs/dev-tools only).
- Frontend translates via i18n. New translation keys to be added (see §H.7).
- This means Worker does NOT need to know about locales, accept `Accept-Language`, or render localized strings. **Big simplification for the Worker.**

### C.4 Retry policy — explicit by code

```ts
function isRetryable(code: string, status: number): boolean {
  if (code === 'TOKEN_EXPIRED') return false; // re-fetch token, then retry the new request
  if (status >= 500) return true;
  if (status === 429) return true;
  return false;
}
```

The Worker SHOULD set `error.retryable: true | false` to make this explicit, but the frontend will not blindly trust the field — `retryable: true` on a 4xx will still be ignored.

### C.5 Error response example

```http
HTTP/1.1 413 Payload Too Large
Content-Type: application/json
Vary: Origin
Access-Control-Allow-Origin: https://oglasino.com

{
  "error": {
    "code": "FILE_TOO_LARGE",
    "message": "Upload exceeds 10485760 bytes (received 14523891 bytes)",
    "details": { "max": 10485760, "received": 14523891 },
    "retryable": false
  }
}
```

---

## D. CORS

> **Scope:** All CORS requirements in this section apply to **web browsers only**. React Native apps make HTTP requests via the native JavaScript runtime; they do not send `Origin` headers, do not perform preflight requests, and are not blocked by CORS rules. The Worker should still set CORS headers correctly for browser security, but RN clients pass through regardless.

### D.1 Origins to allow

| Origin | Why | Operations needed |
|---|---|---|
| `https://oglasino.com` | Production canonical | GET, PUT, OPTIONS |
| `https://www.oglasino.com` | Production www (router redirects to apex but flight in transit) | GET, PUT, OPTIONS |
| `https://oglasino-web.vercel.app` | Production Vercel deployment URL (Worker isn't always in front during preview) | GET, PUT, OPTIONS |
| `https://oglasino-web-*.vercel.app` | Vercel preview deployments (per-PR) — wildcard subdomain | GET, PUT, OPTIONS |
| `http://localhost:3000` | Local `npm run dev` | GET, PUT, OPTIONS |
| `http://localhost:3001` | Local fallback port | GET, PUT, OPTIONS |

The list maps to the existing `experimental.serverActions.allowedOrigins` config in `next.config.ts:18-19` plus localhost. Wildcard handling for Vercel previews must be implemented as proper origin matching (suffix match `.vercel.app` after origin-host), NOT regex on the literal `*` — the Worker should never echo back `*`.

### D.2 Methods

`GET, PUT, POST, OPTIONS, HEAD` — `POST` is not currently used by frontend but reserved for future use; `HEAD` is useful for prefetch existence checks.

`DELETE` is intentionally **not** required from origin requests. Deletion is a backend-only operation and goes through a different auth path (server-to-server with shared secret, see backend's doc).

### D.3 Headers

**Allowed request headers (Access-Control-Allow-Headers):**
- `Content-Type` — required for PUT
- `x-upload-token` — required for PUT
- `Authorization` — only for the (rare) case the Worker exposes a backend-secret-protected admin endpoint. If admin endpoints are backend-side only, omit.

NOT needed: `Cache-Control`, `Pragma`, `X-Requested-With`.

**Exposed response headers (Access-Control-Expose-Headers):**
- `Content-Type`, `Content-Length`, `ETag` (for image GETs — frontend may use ETag for conditional fetch)
- `Retry-After` (for 429 — frontend reads this)
- `cf-cache-status` would be nice for debugging but isn't required

### D.4 Credentials

`Access-Control-Allow-Credentials: false`. The Worker MUST NOT accept cookies — it has no use for them. The web frontend's `axios` config sends `withCredentials: true` to the **backend** (see `src/lib/config/api.ts:16`) but should NOT send credentials when calling the Worker directly. RN doesn't send cookies to the Worker either. The Worker should set `Allow-Credentials: false` defensively so an accidental `withCredentials: true` from a buggy web build is rejected by the browser.

### D.5 Preflight caching

`Access-Control-Max-Age: 86400` (24 hours) so preflights for `PUT` aren't sent on every upload.

### D.6 Vary header

`Vary: Origin` on every CORS-affected response so cached responses for one origin don't serve to another.

---

## E. URL construction patterns

### E.1 What the frontend wants returned from upload

A **full key with prefix**, exactly as it should be stored in the database. No reconstruction by the frontend.

Example successful upload responses:

```json
{ "key": "public/products/9f3e1c20-...-jpg", "bytes": 482301, "contentType": "image/jpeg" }
```

```json
{ "key": "private/chats/abc123/8b2d-...-jpg", "bytes": 102439, "contentType": "image/jpeg" }
```

### E.2 What the frontend constructs itself

Public variants:

```
{cdn-base}/cdn-cgi/image/{params}/{key}
```

Private with view token:

```
{cdn-base}/{key}?token={viewToken}
```

In both cases the `{key}` has its full prefix. The frontend never has to know "is this in `public/products/` or `public/profiles/`" — it just stores and uses the full key returned by upload.

### E.3 Why frontend wants keys, not pre-signed URLs, from upload

- **Variants need the raw key.** The CDN-CGI prefix sits in front of the path, so the frontend needs to combine the variant params with the key, not unpack a pre-signed URL.
- **Storage is canonical.** A stored URL would bake in the CDN hostname and would have to be rewritten if the CDN ever changes hosts. A stored key is stable.
- **Pre-signing isn't applicable to public images** anyway (no token).

### E.4 CDN base URL

The CDN base URL is configured at build time per client (Next.js env var on web, RN environment config on mobile). The Worker contract does not constrain how clients acquire this value — it's a build-time concern that varies per platform.

---

## F. Image processing in the Worker — confirmed NONE

Restating the spec for the contract authors:

| Concern | Where it happens | NOT in Worker |
|---|---|---|
| Resize before upload | Client-side: web uses `browser-image-compression` (Track 4); RN uses platform-equivalent libraries (e.g. `react-native-image-resizer`) | ✓ |
| HEIC → JPEG conversion | Client-side: web `heic2any` (lazy); RN platform API | ✓ |
| Format normalization (PNG without alpha → JPEG) | Client-side per-platform | ✓ |
| Variant resize on display | Cloudflare Image Resizing via `/cdn-cgi/image/` (Track 2) | ✓ |
| Watermarking | Cloudflare Image Resizing `draw` parameter (Track 3) | ✓ |
| EXIF metadata stripping | Cloudflare Image Resizing strips automatically on transform | ✓ |
| Format negotiation (WebP/AVIF/JPEG) | Cloudflare Image Resizing `format=auto` | ✓ |

**The Worker's job is purely:**
1. Validate tokens on PUT and on private GET
2. Validate request constraints (size, content-type, path)
3. Stream bytes to/from R2
4. Return clean errors with stable codes

No pixel manipulation, no transcoding, no thumbnail generation. **If the contract document accidentally includes any image-transformation responsibility for the Worker, that's a defect.**

---

## G. Token lifetimes — frontend requests

| Token | Frontend desired TTL | Hard minimum frontend can tolerate | Why |
|---|---|---|---|
| Upload token | **10 minutes** (matches today) | 5 minutes | Client-side processing of HEIC originals can take 5–10s for large files; user may pause mid-form. 10 min covers all realistic cases. |
| View token (private — chat) | **4 hours preferred, 1 hour minimum** | 30 minutes | User may scroll back through chat history for an hour+ without speaking. With 10-min TTL the chat would re-fetch tokens nearly every action. |

Configurable via Worker env (`UPLOAD_TOKEN_TTL_MS`, `VIEW_TOKEN_TTL_MS`) per the spec — frontend just asks the *defaults* be set to the values above.

---

## H. Edge cases and additional requirements

### H.1 AbortController support

Frontend will pass `AbortSignal` to all `fetch` calls (uploads especially) on both web and RN. Worker should:
- Detect aborted connections (`request.signal.aborted` in Workers runtime)
- NOT write a partial object to R2 when the connection is aborted before all bytes arrive (R2's `put()` is atomic per object — should be fine, but verify)
- Return cleanly without 5xx noise in logs

### H.2 Idempotency on retry

When the frontend retries a failed PUT with the same token:
- If the previous attempt wrote partial bytes (shouldn't happen, but defensively): Worker overwrites cleanly.
- If the previous attempt fully succeeded but the response was lost (bad network — common on mobile): Worker returns the same `{ key, bytes, contentType }` rather than 401 `TOKEN_ALREADY_CONSUMED`. See §I Q4 (RESOLVED in favor of idempotent behavior).

### H.3 Concurrent uploads

Frontend uploads up to 5 images in parallel for a single product / chat message. Worker must handle this — no session-binding, no per-user locks. Each PUT is independent; tokens are independent.

### H.4 Slow connections / large files

Client-side processing caps files at 5 MB after compression (per spec Track 4 on web; RN does the equivalent). Worker enforces 10 MB hard cap as defense-in-depth (allows for HEIC originals before client-side conversion, and for the rare uncompressible PNG with transparency).

A 5 MB upload over LTE can take 30–60 seconds. Frontend will:
- Display a progress UI (web: `XMLHttpRequest` upload progress events or `fetch` with a `ReadableStream`; RN: `react-native-blob-util` or similar)
- Not abort on slow connections — only on user click

Worker should:
- Use Workers' streaming body API (no buffering full upload in memory)
- Allow ~2 minutes of upload time before timing out (Cloudflare's default subrequest limit is 30s — verify this works with R2 streaming. **§I Q5**.)

### H.5 Image preview before upload

When the user picks a file, frontend shows an immediate preview using a local URL (`URL.createObjectURL(file)` on web; native local URI on RN). Worker is not involved. After upload completes, the preview swaps to the CDN URL using the returned `key`.

The Worker contract has no role here; documenting so the contract authors don't propose a pre-upload "show me preview" endpoint.

### H.6 Image deletion — out of scope for v1

Per spec. Frontend does not need a delete-by-key endpoint from Worker. Backend handles deletion via R2 SDK directly. If/when frontend needs to delete (e.g., user removes an avatar), it goes through backend → backend deletes from R2 → backend updates DB.

### H.7 New translation keys frontend will need

Tracked here so the unified contract authors are aware that changes to error codes propagate to translation files. The keys are the frontend's concern (will be requested from the translations agent), but the **codes** in §C.2 must be agreed in the contract because they're the join key.

| New key (proposed) | English text | Tied to error code |
|---|---|---|
| `image.invalid` | "Image is invalid or corrupted" | `TOKEN_MISSING`, `TOKEN_MALFORMED`, `PATH_TRAVERSAL` |
| `image.forbidden` | "You don't have permission to access this image" | `TOKEN_SCOPE_MISMATCH`, `TOKEN_KEY_MISMATCH` |
| `image.bad.format` | "Only JPEG, PNG, WebP, or HEIC images are allowed" | `CONTENT_TYPE_NOT_ALLOWED`, `CONTENT_TYPE_MISMATCH` |
| `image.rate.limited` | "Please slow down and try again in a moment" | `RATE_LIMITED` |
| `image.server.error` | "Something went wrong uploading your image, please retry" | `R2_WRITE_FAILED`, `INTERNAL` |
| `image.processing` | "Processing image…" | (UX during client-side resize) |
| `image.processing.heic` | "Converting HEIC photo…" | (UX during HEIC conversion) |
| `image.processing.compressed` | "Compressed from {original} to {final}" | (Track 4 success messaging) |

Existing keys to keep: `image.too.big`, `image.duplicate`, `image.max`, `image.broke`, `image.not.good`, `images.holder.label`, `images.import`, `add.images.label`, `max.images.alert`, `max.images.label`.

### H.8 Request-ID header for support / debugging

Frontend would like every Worker response (success or error) to include `cf-ray` (Cloudflare provides this automatically) AND a Worker-generated `x-request-id` (UUID). On user-reported errors, frontend can collect the ID and submit a support ticket; backend can correlate with Worker logs.

### H.9 Fallback if Worker is unavailable

There is no fallback. Web renders broken-image placeholders; RN does the equivalent. Uploads surface "image upload failed, please retry." The frontend does not currently use Firebase Storage even though the SDK is initialized (`src/lib/config/firebaseClient.ts:10,35`) — flagged here so the contract authors know there's no shadow image path to consider.

---

## I. Open questions for reconciliation

These are areas where the frontend has a preference but is not certain it's the right call. Listed for the unified-contract author to resolve. Items marked **RESOLVED** are no longer open — they reflect decisions reached during review and are stated here for traceability.

### Q1 — Upload body: raw bytes vs `multipart/form-data`? — **RESOLVED**

**Resolution:** raw bytes (`Blob` on web, equivalent on RN). Both web `fetch` and React Native `fetch` handle raw body types easily. `FormData` adds parsing complexity in the Worker for no benefit. PUT body is the file bytes; `Content-Type` header carries the MIME type.

### Q2 — Database migration: store full key (with prefix) or raw UUID?

Frontend wants full-key-with-prefix returned from upload (§A.6) and wants to store that full key. Today's DB stores raw UUID and the frontend hardcodes `chat-images/{chatId}/` for chat. Storing full key removes that hardcode and is more future-proof, but it's a backend migration.

**Frontend preference:** full key with prefix in DB. Clean break since the spec says we're pre-production and there's no data to migrate.

### Q3 — Worker checks magic bytes on upload?

Spec mentions Content-Type allowlist but not magic-byte sniffing. A user could send `Content-Type: image/jpeg` with arbitrary bytes. Worker MIGHT want to read the first 12 bytes of the upload stream and reject if they don't match a known image signature.

**Frontend preference:** YES, defense-in-depth. Frontend already sends genuinely-image bytes after client-side processing, so this only catches abuse.

But this adds Worker complexity. Decision punted to contract.

### Q4 — Idempotent retry on already-consumed tokens? — **RESOLVED**

**Resolution:** Worker SHOULD detect existing R2 object via `head()` check and return success rather than `TOKEN_ALREADY_CONSUMED` if the object already exists at the token's bound key. Flaky networks (especially mobile) can cause double-submit scenarios where the first PUT succeeded but the response was lost in transit. Orphan prevention is worth the small `head()` overhead.

### Q5 — Worker subrequest timeout for large uploads?

Cloudflare Workers have a 30-second CPU time limit and longer wall-clock for subrequests (R2 puts). Need to verify R2 streaming `put()` doesn't trip this for 10 MB uploads on slow connections. If it does, the contract needs a "max upload duration" clause and the frontend needs to refuse large uploads on slow connections.

### Q6 — Variant URLs with `draw=` (watermark) — does Worker need to know?

The `/cdn-cgi/image/...` prefix is processed by Cloudflare's edge before reaching the Worker, so the Worker doesn't see the variant params. But: does the Worker need to allow Cloudflare to fetch the watermark logo from `https://cdn.oglasino.com/public/brand/logo-watermark.png`? Yes, but that's just a normal public GET — should "just work" once `public/brand/` is allowed unauthenticated read.

**No action needed if `public/*` is broadly allowed**, but flagging for the contract author so it's not overlooked.

### Q7 — Profile picture path: `public/profiles/` or stay under `public/products/`?

Spec leaves this open ("split is optional but recommended"). Frontend doesn't care for v1 — it'll handle whichever full key the upload returns. Backend authors should pick. Frontend's only constraint: upload-token endpoint distinguishes `scope: "product"` vs `scope: "profile"` so the Worker / backend know what prefix to assign.

### Q8 — HEIC support in Worker?

After client-side processing ships on a given client, HEIC files are converted to JPEG before reaching the Worker. So the Worker's allowlist could eventually narrow to `image/jpeg, image/png, image/webp`. **But:** until *both* web AND React Native apps have implemented HEIC→JPEG conversion, HEIC files arrive at the Worker as `image/heic`. RN apps may take longer than web to ship this.

**Frontend preference:** Worker's allowlist includes `image/heic, image/heif` for v1 transition. Don't tighten `ALLOWED_CONTENT_TYPES` until coordinated removal across all client platforms (see §K).

---

## K. Multi-client considerations (web + React Native)

The contract is consumed by both the Next.js web frontend and React Native iOS/Android apps. Both run JavaScript and use the same:

- **Backend endpoints for token issuance** (each client sends Firebase JWT, gets token back)
- **JWT token format** (HS256, parseable by the same JavaScript JWT library on both)
- **HTTP semantics for upload PUT** (raw bytes + `x-upload-token` header)
- **Error response JSON shape** and stable error codes
- **URL patterns** for public variants (`cdn-cgi/image` prefix) and private with token (`?token=` query param)

**Differences:**

- **CORS applies to web only** (RN ignores — no `Origin` header, no preflight)
- **Client-side image processing libraries differ** between web (`browser-image-compression`, `heic2any`) and RN (`react-native-image-resizer` etc.) — both produce equivalent JPEG bytes; the Worker doesn't care which platform produced them
- **HEIC support in Worker is required** until both web AND RN have implemented client-side HEIC→JPEG conversion. Don't tighten `ALLOWED_CONTENT_TYPES` until coordinated removal across all clients (see §I Q8)

The contract should be authored client-agnostic. Anywhere the Worker behavior would meaningfully differ between a web caller and an RN caller is a defect — the only legitimate split is the CORS layer (web-only).

---

## J. Summary table for the unified contract

A condensed view of frontend's binding requirements:

| # | Requirement | Why |
|---|---|---|
| 1 | Tokens issued by backend, never directly to Worker from frontend | Backend has user/chat context |
| 2 | One token = one image | Smallest blast radius |
| 3 | Single-use upload tokens, retry-on-failure within TTL | Idempotency + safety |
| 4 | JWT (HS256) token format | Same library on web + RN |
| 5 | PUT with raw bytes + `x-upload-token` header | Simplest wire format on both clients |
| 6 | Upload response returns full key with prefix (no `publicUrl`) | Clients construct URLs from key + their CDN base |
| 7 | Public images: no token, direct `GET /{key}` | Cacheable by edge |
| 8 | Private images: `?token=` query param | `<img>` / RN `<Image>` can't carry headers |
| 9 | Long view-token TTL (4h preferred) | Chat scrolling UX |
| 10 | View tokens scoped to a chatId, valid for any image in that chat | Cache simplicity |
| 11 | Structured JSON errors with stable `code` field | i18n + retry logic, parses identically on web + RN |
| 12 | All status codes per the table in §C.1 | Distinct UX per failure |
| 13 | CORS allowlist per §D.1, no `*`, no credentials (web only — RN bypasses) | Browser security |
| 14 | No image transformation in Worker | Spec mandate |
| 15 | `Cache-Control: public, max-age=31536000, immutable` on public GETs | Edge cache |
| 16 | `404` (not `403`) for missing keys | No existence leakage |
| 17 | Idempotent PUT — existing R2 object returns success, not `TOKEN_ALREADY_CONSUMED` | Flaky-network orphan prevention (Q4 resolved) |
| 18 | HEIC kept in `ALLOWED_CONTENT_TYPES` until web AND RN ship client-side conversion | Coordinated cross-client lockstep |

---

**End of frontend's input.** Phase 3 (implementation plan) and Phases 4–5 (per-track implementation, testing) await the unified Worker contract.
