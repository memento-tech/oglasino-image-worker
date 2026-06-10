# Oglasino Image Worker

A Cloudflare Worker that gates image `PUT`/`GET` against R2 for Oglasino's image pipeline.
Bytes-only gateway: the backend signs JWTs, this Worker verifies them and streams to/from R2.
No transformation here — Cloudflare Image Resizing handles variants in front of the Worker.

Part of the **Oglasino** platform. Cross-repo specs and conventions live in
[`../oglasino-docs`](../oglasino-docs). The locked contract is
[`jobs/image_pipeline/IMAGE-PIPELINE-WORKER-CONTRACT.md`](jobs/image_pipeline/IMAGE-PIPELINE-WORKER-CONTRACT.md)
— that document is the source of truth; this README is operational guidance.

---

## What the Worker does

- `PUT /{key}` — accepts upload bytes; verifies the upload JWT (HS256), validates size/type/path, writes to R2.
- `GET /public/*` — serves R2 bytes with long cache headers; no auth.
- `GET /private/*` — verifies the view JWT from `?token=`; serves R2 bytes with short, private cache headers.
- `HEAD /{key}` — same auth as GET, headers only.
- `OPTIONS /*` — CORS preflight.

It does **not** issue tokens, resize images, watermark, scan content, or list buckets
(contract §4 and §13.4).

## Tech stack

- **Runtime:** Cloudflare Workers (`nodejs_compat`), R2 binding `BUCKET`
- **Language:** TypeScript; one runtime dependency: [`jose`](https://github.com/panva/jose) (HS256 JWT verify)
- **Tooling:** Wrangler 4, Vitest with `@cloudflare/vitest-pool-workers`, `tsc --noEmit` lint
- **Node:** 22+

## Project structure

```text
src/
├── index.ts              entry point + route dispatch
├── auth/
│   ├── jwt.ts            HS256 verify with dual-secret fallback
│   └── adminAuth.ts      X-Backend-Auth constant-time compare
├── handlers/
│   ├── upload.ts         PUT /{key}
│   ├── view.ts           GET /{key} (public + private)
│   ├── head.ts           HEAD /{key}
│   └── options.ts        CORS preflight
├── lib/
│   ├── cors.ts           origin allowlist, preflight headers
│   ├── errors.ts         buildErrorResponse(code, status, details)
│   ├── logger.ts         structured JSON via console.log
│   ├── pathValidation.ts traversal rejection
│   ├── rateLimit.ts      stub for v1 (see Known gaps)
│   └── requestId.ts      UUID v4 generation/extraction
└── types.ts              shared types: claims, error codes, env
```

`jobs/image_pipeline/` holds the contract, spec, and audit/implementation reports. Contract
section references are inline in each module.

## Local development

**Prerequisites:** Node 22+, `npm install` once. A Cloudflare account with `wrangler login`
is only needed for deploys or `wrangler dev --remote` — pure local dev works without it.

`wrangler dev` reads `.dev.vars` (gitignored) for secrets:

```
# .dev.vars
JWT_SIGNING_SECRET="local-dev-secret-min-32-bytes-please-do-not-reuse"
BACKEND_SHARED_SECRET="local-dev-backend-secret-min-32-bytes-pls"
# Optional, only during a key-rotation window:
# JWT_SIGNING_SECRET_PREVIOUS="prior-secret-value"
```

Generate values with `openssl rand -base64 32`. The same `JWT_SIGNING_SECRET` must be set on
`oglasino-backend` so its signed JWTs verify here.

```bash
npm run dev          # boots on http://localhost:8787; R2 runs against a local miniflare bucket
```

Exercise it with a backend-signed (or test-generated) JWT:

```bash
curl -X PUT http://localhost:8787/public/products/test.jpg \
  -H "x-upload-token: <jwt>" \
  -H "Content-Type: image/jpeg" \
  --data-binary @some-image.jpg
```

## Testing

```bash
npm test               # one-shot
npm run test:watch     # watch mode
npm run test:coverage  # produces coverage/
npm run lint           # tsc --noEmit
```

Tests run via `vitest` with `@cloudflare/vitest-pool-workers`, executing each test inside a
Workers runtime (R2, fetch, crypto are real, not stubbed). Target ≥80% coverage on
`src/handlers/` and `src/auth/`.

## Deployment

Two environments. **No "dev" environment** — local dev runs via `wrangler dev` against local
mocks, and pre-prod testing runs on stage.

| Env | Worker name | Custom domain | R2 bucket |
|---|---|---|---|
| stage | `oglasino-images-stage` | `cdn-staging.oglasino.com` | `oglasino-images-stage` |
| production | `oglasino-images-prod` | `cdn.oglasino.com` | `oglasino-images-prod` |

`wrangler deploy` with no `--env` deploys to **stage** (the top-level `wrangler.toml` mirrors
the stage block). Production requires explicit `--env production` (or merging to `main`).
**Routes / custom domains are bound in the Cloudflare dashboard** (Workers & Pages → worker →
Triggers → Custom Domains), not in `wrangler.toml`.

CI deploys automatically:

- `.github/workflows/ci.yml` — lint + tests on PRs.
- `.github/workflows/deploy.yml` — push to `stage` → stage deploy; push to `main` → production deploy; manual `workflow_dispatch` with an environment selector. The deploy job runs lint + tests, pushes secrets via `wrangler secret put`, then `wrangler deploy --env <env>`.

Local deploy is possible but discouraged (`npm run deploy:stage` / `npm run deploy:production`);
the Worker secrets must already be set on Cloudflare.

### Required GitHub Actions secrets

| Name | Purpose |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Workers Scripts:Edit + R2 Storage:Edit + Workers Routes:Edit |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `JWT_SIGNING_SECRET_STAGE` / `JWT_SIGNING_SECRET_PROD` | HS256 secret per env (matches backend) |
| `BACKEND_SHARED_SECRET_STAGE` / `BACKEND_SHARED_SECRET_PROD` | `X-Backend-Auth` value per env |

### Smoke-test after deploy

Negative cases that don't depend on bucket contents:

```sh
BASE=https://cdn-staging.oglasino.com    # or cdn.oglasino.com for prod

curl -i "$BASE/public/smoke-test/does-not-exist.jpg"            # 404 OBJECT_NOT_FOUND
curl -i "$BASE/private/chats/smoke/anything.jpg"               # 400 TOKEN_MISSING
curl -i "$BASE/private/chats/smoke/anything.jpg?token=not-a-jwt" # 400 TOKEN_MALFORMED
curl -i -X PUT "$BASE/public/products/abc.jpg" -H "Content-Type: image/jpeg" --data-binary "x"  # 400 TOKEN_MISSING
curl -i -X OPTIONS "$BASE/public/products/abc.jpg" -H "Origin: https://evil.example.com" -H "Access-Control-Request-Method: GET"  # no Allow-Origin
curl -i -X OPTIONS "$BASE/public/products/abc.jpg" -H "Origin: https://oglasino.com" -H "Access-Control-Request-Method: GET"      # Allow-Origin echoed
curl -i -X POST "$BASE/public/products/abc.jpg"                # 405
```

For the happy path you need a valid backend-signed JWT with the matching secret — deploy the
backend pointing at the same Worker, ask it for an upload token, then PUT with it. Don't
smoke-test with hand-crafted JWTs unless debugging.

## Secrets management

The source of truth for production secrets is **GitHub Actions repository secrets**. The deploy
workflow pushes them onto the Worker via `wrangler secret put` on every deploy; rotating means
updating the GH secret and redeploying.

| Worker secret | Purpose | Lives as GH secret |
|---|---|---|
| `JWT_SIGNING_SECRET` | HS256 verify for upload + view JWTs | `JWT_SIGNING_SECRET_STAGE`, `JWT_SIGNING_SECRET_PROD` |
| `BACKEND_SHARED_SECRET` | `X-Backend-Auth` (no admin endpoints in v1, set anyway) | `BACKEND_SHARED_SECRET_STAGE`, `BACKEND_SHARED_SECRET_PROD` |
| `JWT_SIGNING_SECRET_PREVIOUS` | Optional dual-key window during rotation | added on first rotation |

The Worker tries `JWT_SIGNING_SECRET` first and falls back to `JWT_SIGNING_SECRET_PREVIOUS`
on **signature failure only** (expired or wrong-issuer tokens are not retried).

### Rotating `JWT_SIGNING_SECRET`

1. Generate `NEW` (`openssl rand -base64 32`); save to the password manager.
2. Add GH secret `JWT_SIGNING_SECRET_PREVIOUS_<ENV>` = current (OLD) value; set `JWT_SIGNING_SECRET_<ENV>` = `NEW`.
3. Add `JWT_SIGNING_SECRET_PREVIOUS` to the `secrets:` list in `deploy.yml` for that env, with the matching `env:` mapping. Commit + merge.
4. Backend: roll its `JWT_SIGNING_SECRET` to `NEW`. Restart.
5. Wait one full `UPLOAD_TOKEN_TTL_MS` + `VIEW_TOKEN_TTL_MS` window (max 4h) so OLD-signed tokens expire.
6. Remove `JWT_SIGNING_SECRET_PREVIOUS` from the workflow, run `wrangler secret delete JWT_SIGNING_SECRET_PREVIOUS --env <env>` once, drop the GH secret.

**Never commit** `.dev.vars`, real secret material, or production R2 bucket contents.

## Known gaps in v1

- **No Worker-level rate limiting.** The backend gates token issuance via Bucket4j (60 tokens/min/user, contract §11.4); upload JWTs are bound to a single key+content-type+maxBytes with a 10-min TTL, so leaked-token abuse is bounded. `lib/rateLimit.ts` is a stub returning `ok` with the extension point marked.
- **No magic-byte content-type sniffing.** The Worker trusts `Content-Type` against the JWT `contentType` claim the backend signed. Deferred per contract §13.4.
- **HEAD/retry byte-size edge case.** The R2 head-check uses `httpMetadata.contentType` + `size`; if R2 returns a drifted size, the idempotent-retry path falls through to a normal write (correct but potentially redundant).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `BUCKET is not defined` on first request | Missing `[[r2_buckets]]` or wrong `--env`. Check `wrangler.toml`. |
| `JWT verify failed: signature` (works locally) | Worker and backend `JWT_SIGNING_SECRET` out of sync. Re-set to the backend's value. |
| `401 TOKEN_ISSUER_INVALID` | Backend signed with `iss` ≠ `oglasino-backend` (contract §5.1). |
| `403 TOKEN_KEY_MISMATCH` on upload | Client PUT to a path different from the JWT `key` claim; PUT to the exact signed path. |
| `415 CONTENT_TYPE_MISMATCH` | PUT `Content-Type` ≠ JWT `contentType`; send the final type (frontend does HEIC→JPEG before upload). |
| CORS fails on a Vercel preview URL | Must match `https://oglasino-web-*.vercel.app`; other projects aren't allowed by design. |

## Related repos

| Repo | Role |
|---|---|
| [`oglasino-backend`](../oglasino-backend) | Signs the upload/view JWTs this Worker verifies |
| [`oglasino-web`](../oglasino-web) · [`oglasino-expo`](../oglasino-expo) | Upload bytes directly to this Worker, render images via the CDN |
| [`oglasino-router`](../oglasino-router) | Sibling Worker — edge routing & maintenance |
| [`oglasino-docs`](../oglasino-docs) | Specs, conventions, decisions |
</content>
