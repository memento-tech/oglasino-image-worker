# oglasino-image-worker

Cloudflare Worker that gates image PUT/GET against R2 for Oglasino's image
pipeline. Bytes-only gateway: backend signs JWTs, Worker verifies them and
streams to/from R2. No transformation here — Cloudflare Image Resizing handles
variants in front of the Worker.

The locked contract is in `jobs/image_pipeline/IMAGE-PIPELINE-WORKER-CONTRACT.md`.
That document is the source of truth; this README is operational guidance.

---

## What the Worker does

- `PUT /{key}` — accepts upload bytes; verifies upload JWT (HS256), validates
  size/type/path, writes to R2.
- `GET /public/*` — serves R2 bytes with long cache headers; no auth.
- `GET /private/*` — verifies view JWT from `?token=` query; serves R2 bytes
  with short, private cache headers.
- `HEAD /{key}` — same auth as GET, headers only.
- `OPTIONS /*` — CORS preflight.

It does NOT issue tokens, resize images, watermark, scan content, or list
buckets. See contract §4 and §13.4.

---

## Local development

### Prerequisites
- Node 20+
- `npm install` once
- A Cloudflare account with `wrangler login` complete (only needed for deploys
  or for `wrangler dev --remote`; pure local dev works without it)

### Secrets for local dev
`wrangler dev` reads `.dev.vars` (which is gitignored) for secrets:

```
# .dev.vars
JWT_SIGNING_SECRET="local-dev-secret-min-32-bytes-please-do-not-reuse"
BACKEND_SHARED_SECRET="local-dev-backend-secret-min-32-bytes-pls"
# Optional, only set during a key rotation window:
# JWT_SIGNING_SECRET_PREVIOUS="prior-secret-value"
```

Generate values with `openssl rand -base64 32`. The same `JWT_SIGNING_SECRET`
must be configured on the backend (`oglasino-backend`) so its signed JWTs
verify here.

### Run the dev server
```
npm run dev
```
Worker boots on `http://localhost:8787`. R2 calls run against a local
miniflare-backed bucket (no real R2 hits).

To exercise it, sign a JWT on the backend side (or generate a test JWT in a
unit test) and:
```
curl -X PUT http://localhost:8787/public/products/test.jpg \
  -H "x-upload-token: <jwt>" \
  -H "Content-Type: image/jpeg" \
  --data-binary @some-image.jpg
```

---

## Testing

```
npm test               # one-shot
npm run test:watch     # watch mode
npm run test:coverage  # produces coverage/
npm run lint           # tsc --noEmit, no transpile
```

Tests run via `vitest` with `@cloudflare/vitest-pool-workers`, which executes
each test inside a Workers runtime (R2, fetch, crypto are real, not stubbed).
Target ≥80% coverage on `src/handlers/` and `src/auth/`.

---

## Deployment

Two environments. **No "dev" environment** — local development runs via
`wrangler dev` against local mocks, and pre-prod testing runs on staging.

| Env | Worker name | Custom domain | R2 bucket |
|---|---|---|---|
| staging | `oglasino-images-staging` | `cdn-staging.oglasino.com` | `oglasino-images-staging` |
| production | `oglasino-images` | `cdn.oglasino.com` | `oglasino-images-prod` |

`wrangler deploy` with no `--env` flag deploys to **staging** (the top-level
config in `wrangler.toml` mirrors the staging block). Production requires
explicit `--env production` (or merging to `main`, which the deploy workflow
handles).

### First-time setup per environment
1. R2 bucket created via `wrangler r2 bucket create <name>` or the CF
   dashboard. (Done.)
2. Custom domain bound via Cloudflare dashboard → Workers & Pages →
   `<worker>` → Triggers → Custom Domains. Cloudflare manages DNS
   automatically — no manual A/CNAME records. (Done.)
3. Secrets configured as **GitHub Actions secrets** (NOT pre-set on the
   Worker). The deploy workflow pushes them on every deploy via
   `wrangler secret put`. See "Secrets management" below.

### Deploy

CI deploys automatically:
- Push to `dev` branch → staging deploy
- Push to `main` branch → production deploy
- Manual `workflow_dispatch` with environment selector

The deploy workflow (`.github/workflows/deploy.yml`):
1. Runs lint + tests
2. Pushes secrets to the target Worker via `wrangler secret put`
3. Runs `wrangler deploy --env <staging|production>`

Local deploy is also possible (use sparingly, prefer CI):
```
npm run deploy:staging
npm run deploy:production
```
For a local deploy you must already have the Worker secrets set on
Cloudflare (CI pushes them automatically; locally you'd run
`wrangler secret put JWT_SIGNING_SECRET --env <env>` once).

### Required GitHub Actions repository secrets

| Name | Purpose |
|---|---|
| `IMAGES_API_TOKEN` | Cloudflare API token (Workers Scripts:Edit + R2 Storage:Edit + Workers Routes:Edit) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `JWT_SIGNING_SECRET_STAGING` | HS256 secret for staging Worker (matches backend's staging secret) |
| `JWT_SIGNING_SECRET_PROD` | HS256 secret for production Worker |
| `BACKEND_SHARED_SECRET_STAGING` | `X-Backend-Auth` value for staging |
| `BACKEND_SHARED_SECRET_PROD` | `X-Backend-Auth` value for production |

### Smoke-test after deploy

Run these against the just-deployed environment. Each is intentionally a
negative case so they don't depend on bucket contents.

```sh
BASE=https://cdn-staging.oglasino.com    # or cdn.oglasino.com for prod

# 1. Public GET on a non-existent key → 404 OBJECT_NOT_FOUND
curl -i "$BASE/public/smoke-test/does-not-exist.jpg"

# 2. Private GET without ?token → 400 TOKEN_MISSING
curl -i "$BASE/private/chats/smoke/anything.jpg"

# 3. Private GET with garbage token → 400 TOKEN_MALFORMED
curl -i "$BASE/private/chats/smoke/anything.jpg?token=not-a-jwt"

# 4. PUT without x-upload-token → 400 TOKEN_MISSING
curl -i -X PUT "$BASE/public/products/abc.jpg" \
  -H "Content-Type: image/jpeg" \
  --data-binary "x"

# 5. CORS preflight from disallowed origin → no Allow-Origin in response
curl -i -X OPTIONS "$BASE/public/products/abc.jpg" \
  -H "Origin: https://evil.example.com" \
  -H "Access-Control-Request-Method: GET"

# 6. CORS preflight from allowed origin → Allow-Origin echoed
curl -i -X OPTIONS "$BASE/public/products/abc.jpg" \
  -H "Origin: https://oglasino.com" \
  -H "Access-Control-Request-Method: GET"

# 7. Method not allowed → 405
curl -i -X POST "$BASE/public/products/abc.jpg"
```

For the round-trip happy path you need a valid JWT signed by the backend with
the matching secret. The fastest path to verify this: deploy the backend
pointing at the same Worker, ask it for an upload token, then PUT with that
token. Don't smoke-test with hand-crafted JWTs unless you're debugging.

After verifying, record the deployed staging URL in the PR description and
in the team password manager alongside the secrets.

---

## Secrets management

The source of truth for production secrets is **GitHub Actions repository
secrets** (see Deployment section). The deploy workflow pushes them onto the
Worker via `wrangler secret put` on every deploy. Cloudflare keeps the value
encrypted at rest; rotating means updating the GH secret and redeploying.

| Worker secret | Purpose | Lives as GH secret |
|---|---|---|
| `JWT_SIGNING_SECRET` | HS256 verify for upload + view JWTs | `JWT_SIGNING_SECRET_STAGING`, `JWT_SIGNING_SECRET_PROD` |
| `BACKEND_SHARED_SECRET` | `X-Backend-Auth` (no admin endpoints in v1, set anyway) | `BACKEND_SHARED_SECRET_STAGING`, `BACKEND_SHARED_SECRET_PROD` |
| `JWT_SIGNING_SECRET_PREVIOUS` | Optional dual-key window during rotation | not configured yet — added on first rotation |

### Rotating `JWT_SIGNING_SECRET`
1. Generate `NEW` via `openssl rand -base64 32`. Save to password manager.
2. Add a new GH Actions secret `JWT_SIGNING_SECRET_PREVIOUS_<ENV>` with the
   current (OLD) value. Update `JWT_SIGNING_SECRET_<ENV>` to `NEW`.
3. Add `JWT_SIGNING_SECRET_PREVIOUS` to the `secrets:` list in
   `.github/workflows/deploy.yml` for the same environment, with the
   matching `env:` mapping. Commit + merge.
4. Backend: roll its `JWT_SIGNING_SECRET` to `NEW`. Restart.
5. Wait one full `UPLOAD_TOKEN_TTL_MS` + `VIEW_TOKEN_TTL_MS` window (max 4
   hours) so any tokens signed with OLD have expired.
6. Remove `JWT_SIGNING_SECRET_PREVIOUS` from the workflow `secrets:` list.
   Run `wrangler secret delete JWT_SIGNING_SECRET_PREVIOUS --env <env>` once
   manually to remove it from the Worker. Drop the GH secret too.

The Worker tries `JWT_SIGNING_SECRET` first and falls back to
`JWT_SIGNING_SECRET_PREVIOUS` on signature failure (and only signature
failure — expired or wrong-issuer tokens are not retried).

### Never commit
- `.dev.vars` (gitignored)
- Anything containing real secret material
- Production R2 bucket contents (separate system)

---

## Known gaps in v1

- **No Worker-level rate limiting.** Backend gates token issuance via Bucket4j
  (60 tokens/min/user, contract §11.4). Upload JWTs are bound to a single
  key+content-type+maxBytes with a 10-min TTL, so leaked-token abuse is
  bounded. `lib/rateLimit.ts` is a stub returning `ok` with the extension
  point clearly marked. Add KV or Durable Object backing when needed.
- **No magic-byte content-type sniffing.** Worker trusts the `Content-Type`
  header against the JWT claim. Browser-side processing pipeline normalizes
  before upload; an attacker bypassing the browser can still mislabel, but
  that's bounded by the JWT `contentType` claim that the backend signed.
  Deferred per contract §13.4 / backend §I Q3.
- **No HEAD endpoint test against the original byte size for idempotent
  retry.** The R2 head-check uses `httpMetadata.contentType` and `size`. If
  Cloudflare's R2 client returns sizes that drift from the original
  Content-Length (e.g., due to ETag-only response), the retry path falls
  through to a normal write — correct but potentially redundant.

---

## Troubleshooting

**`wrangler dev` boots but `BUCKET is not defined` on first request**
You're missing the `[[r2_buckets]]` entry or running with `--env <x>` that
lacks one. Check `wrangler.toml`.

**`JWT verify failed: signature` for tokens that work locally**
Worker and backend `JWT_SIGNING_SECRET` are out of sync. Re-set the Worker
secret with the same value the backend uses.

**`401 TOKEN_ISSUER_INVALID`**
Backend signed with `iss` other than `oglasino-backend`. The Worker enforces
this exact issuer per contract §5.1.

**`403 TOKEN_KEY_MISMATCH` on upload**
Client PUT to a path different from the JWT's `key` claim. Backend signs the
exact full key (`public/products/<uuid>.<ext>`); client must PUT to that
path verbatim.

**`415 CONTENT_TYPE_MISMATCH`**
The `Content-Type` header on the PUT differs from the JWT `contentType`
claim. Frontend processes images (HEIC→JPEG) before uploading; make sure the
header reflects the final type, not the original picker selection.

**CORS preflight fails on a Vercel preview URL**
Preview URL must match `https://oglasino-web-*.vercel.app`. Other Vercel
projects on the same account aren't allowed by design.

---

## Where things live

```
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

Contract section references are inline in each module.
