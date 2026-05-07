# Oglasino — Image Pipeline Improvements Specification

**Status:** Approved for implementation
**Owner:** Igor
**Last updated:** 2026-05-06
**Affects:** Backend (Spring Boot), Frontend (Next.js), Cloudflare Worker, R2 bucket

---

## Table of Contents

- [Overview](#overview)
- [Goals and non-goals](#goals-and-non-goals)
- [Current state](#current-state)
- [Target architecture](#target-architecture)
- [Implementation order](#implementation-order)
- [Track 0 — Worker contract and rewrite](#track-0--worker-contract-and-rewrite)
- [Track 1 — Privacy hardening and bucket reorganization](#track-1--privacy-hardening-and-bucket-reorganization)
- [Track 2 — Cloudflare Image Resizing for delivery variants](#track-2--cloudflare-image-resizing-for-delivery-variants)
- [Track 3 — Watermarking on delivery](#track-3--watermarking-on-delivery)
- [Track 4 — Browser-side upload pipeline](#track-4--browser-side-upload-pipeline)
- [Configuration](#configuration)
- [Testing strategy](#testing-strategy)
- [Out of scope for v1](#out-of-scope-for-v1)

---

## Overview

This work modernizes Oglasino's image pipeline to:

1. Reduce storage and bandwidth costs by compressing/resizing on upload
2. Serve responsive image variants on demand via Cloudflare Image Resizing
3. Watermark product images at delivery time (not upload time)
4. Verify and harden access controls for private images
5. Reorganize the R2 bucket structure for clearer separation of public and private content

The architecture stays on R2 + Cloudflare Image Resizing (not Cloudflare Images), which is significantly cheaper at scale for view-heavy content like a classifieds marketplace.

---

## Goals and non-goals

**Goals:**

- Browser-side resize and compression before upload
- Two delivery variants: `card` (400×300) and `hero` (1600×1200)
- Watermark logo bottom-right on hero variant only
- Audit and fix Worker security issues
- Rename `/chat-images/` to `/private/` with subfolders for chats and (later) reports
- Document the image access model end-to-end

**Non-goals (deferred):**

- Migration to Cloudflare Images (rejected — too expensive at scale)
- Watermarking at upload time (rejected — less flexible)
- More than two variants for v1
- Report image upload (separate feature, future)
- Image moderation (AI scanning for inappropriate content)
- Image metadata stripping (EXIF removal) — Cloudflare strips on resize automatically
- Image deduplication (same image uploaded twice gets two entries)

---

## Current state

### Storage layout (today)

```
oglasino-images-prod/
├── {uuid}.{ext}              ← public images (products, profiles)
└── chat-images/
    └── {chatId}/
        └── {uuid}.{ext}      ← private chat attachments
```

### Worker (today)

- `POST /api/{accountId}/get-token` — issues upload token (validates `TOKEN_ID` bearer)
- `POST /api/{accountId}/get-view-token` — issues view token for chat images (validates `TOKEN_ID` bearer)
- `PUT /` — accepts upload with `x-upload-token` header
- `GET /` — serves images, validates `?token=` query param for chat-images path
- Token TTL: 10 minutes hardcoded

### Backend (today)

- `DefaultImageService` calls Worker to get tokens
- `R2Service` handles direct R2 deletion (S3-compatible)
- Image keys stored on entities (not full URLs)
- Frontend constructs URLs from keys via direct R2 access

### Frontend (today)

- Validates max upload size: 5 MB
- No browser-side resize, compression, or format conversion
- Uploads original file as-is to Worker
- Constructs image URLs as `https://cdn.oglasino.com/{key}` (direct R2)

### Identified issues

See [Worker security fixes](#worker-security-fixes) below for the full list.

---

## Target architecture

### Storage layout (target)

```
oglasino-images-prod/
├── public/
│   ├── products/{uuid}.{ext}     ← product listing images
│   └── profiles/{uuid}.{ext}     ← profile pictures (future split)
└── private/
    ├── chats/
    │   └── {chatId}/
    │       └── {uuid}.{ext}      ← chat attachments (renamed from chat-images)
    └── reports/                  ← future, NOT in v1
        └── {reportId}/
            └── {uuid}.{ext}
```

For v1, products and profiles can stay at `public/` root if separating them is too disruptive — split is optional but recommended.

### Delivery flow

**Public images (product listings):**

```
Browser requests → https://cdn.oglasino.com/cdn-cgi/image/{variant}/public/products/{uuid}.jpg
  → Cloudflare Image Resizing applies variant transform (resize + watermark for hero)
  → Cloudflare R2 Custom Domain serves original
  → Edge caches transformed result (free for repeated views)
```

**Private images (chat attachments):**

```
Browser requests → https://cdn.oglasino.com/private/chats/{chatId}/{uuid}.jpg?token={token}
  → Cloudflare Worker validates token + chat membership
  → Worker serves R2 object
  → No edge cache (token-bound)
```

For v1, private images get NO Image Resizing variants. Always served at original size. Adding variants for private images requires Worker changes that can come later.

### Upload flow (target)

```
1. User selects images in frontend
2. Frontend resizes + compresses + converts format in browser:
   - Max dimension 2400px (longest side)
   - JPEG quality 85
   - Convert HEIC/PNG to JPEG (unless PNG has transparency)
3. Frontend POSTs to backend → backend POSTs to Worker → Worker returns one-time upload token
4. Frontend PUTs processed image to Worker with token
5. Worker validates token, content type, size; writes to R2
6. Worker returns full key (with prefix) to frontend
7. Frontend submits the key to backend for entity association
```

---

## Track 1 — Privacy hardening and bucket reorganization

### Bucket reorganization

Rename folders. Since you're pre-production, no data migration needed.

| Old path | New path |
|---|---|
| `chat-images/{chatId}/{uuid}.{ext}` | `private/chats/{chatId}/{uuid}.{ext}` |
| `{uuid}.{ext}` | `public/products/{uuid}.{ext}` (optional split) |

### Worker changes

Update path matching:

```javascript
// Old
if (key.startsWith("chat-images/")) {

// New
if (key.startsWith("private/")) {
```

Update upload prefix logic:

```javascript
// Old
const prefix = chatId ? `chat-images/${chatId}/` : "";

// New
const prefix = chatId ? `private/chats/${chatId}/` : "public/products/";
```

### Backend changes

Update `R2Service` and any hardcoded path references. Keys stored in DB don't need migration if the prefix is stripped/added consistently — but for cleanliness, store the full key with prefix.

### Privacy verification checklist

The implementing agent must verify each:

- [ ] Direct GET to `https://cdn.oglasino.com/private/chats/{chatId}/{uuid}.jpg` (no token) returns 401
- [ ] GET with valid token but for different chatId returns 401
- [ ] GET with expired token returns 401
- [ ] GET with malformed token returns 401
- [ ] No way to list bucket contents (R2 listing API not exposed)
- [ ] R2 Connect Custom Domain doesn't bypass Worker auth for `/private/*`
- [ ] Upload tokens cannot be used to upload to a different chat's folder
- [ ] Upload tokens expire after 10 minutes
- [ ] CORS does not allow uploads from arbitrary origins

---

## Track 2 — Cloudflare Image Resizing for delivery variants

### Enable Image Resizing

Cloudflare dashboard → Speed → Optimization → Image Resizing → On.

Cost: $5/month on free tier, included on Pro plan.

### Variant definitions

| Variant | Width | Height | Fit | Format | Quality | Watermark |
|---|---|---|---|---|---|---|
| `card` | 400 | 300 | cover | auto | 85 | No |
| `hero` | 1600 | 1200 | scale-down | auto | 85 | Yes (Track 3) |

`format=auto` serves WebP to Chrome/Firefox/Edge, AVIF to Safari 16+, JPEG fallback elsewhere.

`fit=cover` for cards crops to exact dimensions (good for grid layouts).
`fit=scale-down` for hero preserves aspect ratio, only shrinks (never enlarges).

### Frontend URL helper

Centralize variant URL construction:

```typescript
// src/lib/images/variants.ts

const CDN_BASE = process.env.NEXT_PUBLIC_CDN_URL || 'https://cdn.oglasino.com';

export type ImageVariant = 'card' | 'hero' | 'original';

const VARIANTS: Record<Exclude<ImageVariant, 'original'>, string> = {
  card: 'width=400,height=300,fit=cover,format=auto,quality=85',
  hero: 'width=1600,height=1200,fit=scale-down,format=auto,quality=85',
};

export function imageUrl(key: string, variant: ImageVariant = 'card'): string {
  if (!key) return '';
  if (variant === 'original') return `${CDN_BASE}/${key}`;
  return `${CDN_BASE}/cdn-cgi/image/${VARIANTS[variant]}/${key}`;
}

// Usage:
// imageUrl('public/products/abc.jpg', 'card')
//   → https://cdn.oglasino.com/cdn-cgi/image/width=400,...,format=auto/public/products/abc.jpg
```

### Replace direct URLs throughout app

Search for direct `cdn.oglasino.com/${key}` usage and replace with `imageUrl(key, variant)`. Common locations:

- Product card components (use `card`)
- Product detail page main image (use `hero`)
- Lightbox / zoomed view (use `hero`)
- Profile pictures (use `card` or future `avatar` variant)

Private images stay using direct URLs with token query string (no variants in v1).

---

## Track 3 — Watermarking on delivery

### Logo setup

Upload logo to a public, Cloudflare-accessible URL:

```
https://cdn.oglasino.com/public/brand/logo-watermark.png
```

Logo specs:
- PNG with transparency
- ~200×60px (or whatever your logo aspect ratio is)
- White or high-contrast for visibility on dark and light backgrounds
- Alternative: two logos (light + dark) and pick based on... too complex for v1

### Watermark via `draw` parameter

Cloudflare Image Resizing supports compositing one image onto another via the `draw` parameter:

```
https://cdn.oglasino.com/cdn-cgi/image/width=1600,height=1200,fit=scale-down,format=auto,draw=[{"url":"https://cdn.oglasino.com/public/brand/logo-watermark.png","bottom":20,"right":20,"width":120,"opacity":0.7}]/public/products/abc.jpg
```

The `draw` parameter takes JSON-encoded array. Must be URL-encoded properly.

Update the variant helper:

```typescript
const VARIANTS: Record<Exclude<ImageVariant, 'original'>, string> = {
  card: 'width=400,height=300,fit=cover,format=auto,quality=85',
  hero: buildHeroVariant(),
};

function buildHeroVariant(): string {
  const draw = encodeURIComponent(JSON.stringify([{
    url: 'https://cdn.oglasino.com/public/brand/logo-watermark.png',
    bottom: 20,
    right: 20,
    width: 120,
    opacity: 0.7,
  }]));
  return `width=1600,height=1200,fit=scale-down,format=auto,quality=85,draw=${draw}`;
}
```

### Watermark policy

| Image type | Variant | Watermark? |
|---|---|---|
| Product listing | `card` | No (too small) |
| Product listing | `hero` | Yes |
| Profile picture | any | No |
| Chat attachment | n/a (no variants) | No |
| Brand assets | n/a | No |

Future: per-user customization, removing watermark for premium users, etc. Out of scope.

### Testing watermarks

Verify visually after deploy:
- Watermark visible but not obscuring product
- Same position regardless of image aspect ratio
- Doesn't break for portrait images
- Doesn't break for very small uploaded images (after browser resize, what if image is < 400px?)

---

## Track 4 — Browser-side upload pipeline

### Goals

- Reduce storage cost (don't store 4K images when display max is 1600px)
- Faster perceived upload (smaller files upload faster)
- Format normalization (convert HEIC to JPEG)
- Preserve image quality at delivery sizes (don't over-compress)

### Pipeline

Per uploaded file, run these steps in order:

1. **Validate type:** must be `image/jpeg`, `image/png`, `image/webp`, `image/heic`, or `image/heif`
2. **Validate file size:** max 10 MB (raised from 5 MB to allow HEIC originals before conversion)
3. **Decode image:** use Canvas API or library like `browser-image-compression`
4. **Validate dimensions:** max 8000×8000px raw input (anything bigger is suspicious)
5. **Resize:** if longest side > 2400px, resize to 2400px maintaining aspect ratio. If smaller, keep as-is.
6. **Format conversion:**
    - HEIC/HEIF → JPEG quality 85
    - PNG without transparency → JPEG quality 85
    - PNG with transparency → keep as PNG (rare for product photos)
    - JPEG → re-encode at quality 85 (idempotent enough — won't visibly degrade)
    - WebP → keep as WebP
7. **Final size check:** max 5 MB after processing. If still larger, reduce quality to 75 and retry.
8. **Upload processed file** through existing flow

### Library choice

Recommended: `browser-image-compression` (npm)

- ~14 KB gzipped
- Handles all the above except HEIC
- Returns a Blob ready for upload

For HEIC: `heic2any` (npm) — converts HEIC to JPEG/PNG in browser. Larger (~250 KB) but only loaded when HEIC is detected. Use dynamic import.

### UX

- Show progress: "Processing image..." while resize happens (typically <1s on modern devices)
- Show before/after sizes: "5.2 MB → 880 KB"
- Show resize info: "Resized from 4032×3024 to 2400×1800"
- Allow user to cancel mid-process

### Where in the codebase

Add a new module: `src/lib/images/processImage.ts`

```typescript
export interface ProcessedImage {
  blob: Blob;
  originalSize: number;
  processedSize: number;
  originalDimensions: { width: number; height: number };
  processedDimensions: { width: number; height: number };
  format: 'jpeg' | 'png' | 'webp';
}

export async function processImageForUpload(file: File): Promise<ProcessedImage> {
  // ... pipeline implementation
}
```

Call from existing image upload component(s).

---

## Implementation order

The Worker is the contract between backend and frontend. Both consume it. Therefore:

1. **Phase A** — Frontend agent and backend agent each produce their **required Worker contract** (what endpoints they need, what request/response shapes, what authentication, what error semantics). Outputs go into separate documents (`jobs/image_pipeline/IMAGE-PIPELINE-WORKER-NEEDS-FRONTEND.md` and `jobs/image_pipeline/IMAGE-PIPELINE-WORKER-NEEDS-BACKEND.md`). Igor reconciles into a unified Worker contract document.

2. **Phase B** — Backend implements the new Worker per the agreed contract (Track 0). Worker is deployed to a staging route or development namespace.

3. **Phase C** — Backend and frontend implement their respective changes against the new Worker. They proceed in parallel:
    - Backend: Track 1 (bucket reorganization, R2Service updates, image service path changes)
    - Frontend: Track 2 (variants), Track 3 (watermark), Track 4 (upload pipeline)

4. **Phase D** — Worker promoted to production route. Backend and frontend deployed in coordination.

Critical rule: **No track 1-4 implementation begins until the Worker contract is agreed and Track 0 is in progress.** This prevents implementing against assumed-but-not-yet-real Worker behavior.

---

## Track 0 — Worker contract and rewrite

The current Worker has multiple security and architectural issues. Rather than patch incrementally, this track rewrites the Worker from scratch with a clean contract derived from frontend and backend needs.

### Goals of the rewrite

- Restrictive CORS (only Oglasino domains)
- Content-type allowlist on upload
- Size limit enforced server-side (defense in depth — frontend already validates)
- Configurable TTL via env vars
- No image transformation in the Worker (transformation happens via `/cdn-cgi/image/...` in front of Worker)
- Clear separation of concerns: token issuance, upload, serve
- Proper error responses with informative messages (not just "Unauthorized")
- Logging of denied operations for audit trail
- Use `crypto.randomUUID()` not custom regex
- Return full key (with prefix) on upload, so callers don't have to reconstruct

### Worker contract specification

The contract document (produced after Phase A) must define:

**Endpoints:**
- For each endpoint: HTTP method, path, request headers, request body schema, success response schema, error response schema, auth model

**Authentication model:**
- How upload tokens are issued and bound (to what scope: user, chat, listing, etc.)
- How view tokens are issued for private images
- TTL for each token type
- Rotation/revocation strategy if any

**Path conventions:**
- How keys are constructed (what prefix structure)
- What the Worker returns to the caller as a "key"
- How the caller constructs subsequent URLs (with token, with variant, etc.)

**Error semantics:**
- HTTP status codes for each failure mode
- Error response body structure (JSON with code + message, or just text)
- What errors are retryable vs permanent

**CORS policy:**
- Which origins allowed for which operations
- Preflight handling

**Limits:**
- Max upload size (per request, per token)
- Max requests per token (one-time vs reusable)
- Token TTL ranges

### Phase A: Required input from frontend agent

Frontend agent must produce `jobs/image_pipeline/IMAGE-PIPELINE-WORKER-NEEDS-FRONTEND.md` answering:

1. **Upload flow**
    - For each upload type (product image, profile picture, chat attachment, future report image):
        - When does the frontend need an upload token?
        - What does the frontend know at token-request time? (user ID, chat ID, listing draft ID, etc.)
        - Is the frontend talking directly to the Worker for tokens, or through the backend?
        - Should the upload token be bound to a single image, or can one token upload N images for the same listing?
        - What does the frontend need back from the upload response? (key, URL, dimensions, mime type)

2. **Display flow**
    - For private images: how does the frontend get a view token? When? Is it cached?
    - For public images: does the frontend ever need a token, or is direct URL access fine?
    - How long are view tokens valid before frontend needs to refresh?
    - What URL format does the frontend want? (relative path + token query, or full URL pre-signed)

3. **Error handling**
    - What error codes/messages does the frontend want to display to users?
    - Are there cases where the frontend needs to retry vs. show a permanent error?
    - Should the Worker return localized error messages, or just codes that frontend translates?

4. **CORS origins**
    - List all origins that should be allowed to call the Worker
    - Distinguish between origins for upload vs. download vs. token issuance

5. **Anything else** the Worker should provide for frontend ergonomics

### Phase A: Required input from backend agent

Backend agent must produce `jobs/image_pipeline/IMAGE-PIPELINE-WORKER-NEEDS-BACKEND.md` answering:

1. **Authentication and authorization**
    - When does the backend issue tokens via Worker vs. directly to frontend?
    - What backend-to-Worker authentication is used? (shared secret, mTLS, signed JWT)
    - Should view token issuance verify chat membership at backend before calling Worker, or should Worker verify some claim?
    - How is admin/system access (delete, list) authenticated?

2. **Backend-only operations**
    - What operations does only the backend need? (delete by key, bulk delete, list by prefix)
    - Should these be Worker endpoints or direct R2 operations?
    - What's the auth model for these?

3. **Path/key conventions**
    - What key format does the backend want stored in DB? (full path with prefix, or just UUID)
    - How does backend handle backwards compatibility for existing image references?

4. **Audit and observability**
    - What events should the Worker log? (failed auth attempts, oversized uploads, invalid types)
    - Should the Worker push logs to a backend webhook, or rely on Cloudflare logs?

5. **Error responses for backend consumption**
    - Backend doesn't display errors to users — needs structured responses for retry logic, alerting, etc.
    - JSON error format with codes preferred over plain text

6. **CORS origins** (likely none — backend calls server-to-server, no Origin header)

7. **Anything else** the Worker should provide for backend operations

### Phase A: Reconciliation

Igor (or a follow-up document) consolidates both agents' outputs into the unified Worker contract: `jobs/image_pipeline/IMAGE-PIPELINE-WORKER-CONTRACT.md`.

This unified document is the **only source of truth** for what the Worker does. Everything in it must be agreed by both agents before Phase B begins.

### Phase B: Worker implementation

Owned by backend agent (Worker code traditionally lives near backend code, easier to coordinate with R2Service changes).

The implementation must:

- Match the contract exactly (no undocumented endpoints, no undocumented behavior)
- Include comprehensive inline comments referencing contract sections
- Use environment variables for ALL configurable values:
    - `ALLOWED_ORIGINS` (comma-separated list)
    - `UPLOAD_TOKEN_TTL_MS`
    - `VIEW_TOKEN_TTL_MS`
    - `MAX_UPLOAD_BYTES`
    - `ALLOWED_CONTENT_TYPES` (comma-separated)
    - `BACKEND_SHARED_SECRET` (for backend-to-Worker auth)
    - `BUCKET_BINDING` (R2 binding name, configured in wrangler)
    - `ENVIRONMENT` (production / development / staging)
- Include unit tests using Vitest (Cloudflare Workers test framework)
- Include a `wrangler.toml` with all configuration documented
- Include deployment instructions in a Worker-specific README

### Phase B: Worker deployment strategy

1. Deploy new Worker to a staging route first (e.g., `images-staging.oglasino.com`)
2. Backend can point to staging Worker via env override for testing
3. Frontend can point to staging Worker via env override for testing
4. End-to-end test against staging
5. Promote to production route only after both agents confirm working
6. Old Worker code archived (kept in version control), can be reverted if needed

### Worker security requirements (enforced in implementation)

These are non-negotiable, regardless of contract details:

- **CORS:** No `Access-Control-Allow-Origin: *`. Origin must be in allowlist.
- **Content-Type validation on upload:** Must be in allowlist (jpeg, png, webp, gif, avif). Reject otherwise.
- **Size limit on upload:** Server-side enforcement via Content-Length check. Reject early to avoid wasting bandwidth.
- **Token validation:** Constant-time comparison for hash check (prevent timing attacks). Already correct in existing implementation but verify.
- **Path traversal prevention:** Reject keys containing `..` or absolute paths.
- **No directory listing:** Worker never exposes listing operations to public callers.
- **Verbose errors only when safe:** Detailed errors for auth failures may help attackers. Use generic "Unauthorized" externally, log details internally.
- **No secrets in URL:** Tokens may appear in logs/referer; document this risk and use short TTLs.

### What the new Worker DOES NOT do

For clarity:

- Does NOT do image transformation (handled by Cloudflare Image Resizing in front)
- Does NOT do caching beyond Cloudflare's default (R2 + edge cache)
- Does NOT do image moderation or virus scanning
- Does NOT issue long-lived tokens (TTL max 1 hour by policy)
- Does NOT support reusable tokens (each upload token usable once)
- Does NOT support cross-tenant access (each token bound to specific scope)

---

## Configuration

### Backend `application.yml`

No new configuration needed for v1. Existing `cloudflare.*` properties remain.

### Frontend `next.config.ts`

Add the watermark logo URL pattern to `images.remotePatterns` if using Next.js Image component:

```typescript
images: {
  remotePatterns: [
    {
      protocol: 'https',
      hostname: 'cdn.oglasino.com',
      pathname: '/**',
    },
  ],
}
```

### Worker environment variables

Configured in `wrangler.toml` and Cloudflare dashboard. Final list determined by Worker contract (Track 0). Initial set:

| Variable | Type | Purpose |
|---|---|---|
| `ALLOWED_ORIGINS` | comma-separated string | CORS origin allowlist |
| `UPLOAD_TOKEN_TTL_MS` | integer | Upload token lifetime (default 600000 = 10 min) |
| `VIEW_TOKEN_TTL_MS` | integer | View token lifetime (default 3600000 = 1 hour) |
| `MAX_UPLOAD_BYTES` | integer | Max upload size (default 10485760 = 10 MB) |
| `ALLOWED_CONTENT_TYPES` | comma-separated string | Allowed mime types for uploads |
| `BACKEND_SHARED_SECRET` | secret | Backend-to-Worker auth (configured as Worker secret, not plain env var) |
| `ENVIRONMENT` | string | `production` / `staging` / `development` |
| `BUCKET_BINDING` | binding | R2 bucket binding (configured in wrangler.toml) |

---

## Testing strategy

### Track 1 (Privacy)

- Direct curl to `cdn.oglasino.com/private/chats/abc/xyz.jpg` without token → expect 401
- Curl with expired token → 401
- Curl with token for different chat → 401
- Curl with valid token for correct chat → 200 with image bytes

### Track 2 (Variants)

- Visit `https://cdn.oglasino.com/cdn-cgi/image/width=400,format=auto/public/products/test.jpg`
- Verify in DevTools Network tab: response is `image/webp` for Chrome, `image/avif` for Safari
- Verify dimensions match variant spec
- Verify cached on second request (`cf-cache-status: HIT`)

### Track 3 (Watermark)

- Visit hero variant URL for a test product
- Verify watermark visible bottom-right
- Verify position correct on portrait, landscape, square images
- Verify watermark not present on card variant

### Track 4 (Upload pipeline)

- Upload a 4K iPhone HEIC photo → verify result is JPEG, max 2400px, < 5 MB
- Upload a transparent PNG (e.g., logo) → verify stays as PNG
- Upload a 50 MB image → verify rejected at validation step
- Upload a malformed image → verify graceful error
- Upload a non-image file → verify rejected

### Worker

- All security fixes verified via direct curl
- Browser test from oglasino.com → upload works
- Browser test from random.example.com → CORS blocks request

---

## Out of scope for v1

- Migration of existing R2 images to new bucket structure (pre-production, throwaway data)
- Variants for private images (always served at original size for chat for v1)
- Per-user watermark policies (e.g., remove for premium users)
- AI-based image moderation
- Image deduplication
- EXIF metadata stripping (Cloudflare Image Resizing strips automatically on transform)
- Multiple watermark variants (light/dark logo)
- Animated images (GIF/WebP) — handle as static for now, may break animations
- Image cropping UI on upload
- Bulk upload progress indicator improvements
- Report image upload (separate feature)