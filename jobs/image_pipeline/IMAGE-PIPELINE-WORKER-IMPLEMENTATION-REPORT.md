# Worker implementation handoff — `oglasino-image-worker`

**Status:** Worker code, tests, and CI/CD complete. Two deploys triggered (main → production, dev → staging) but **not yet verified by me** — you/orchestrator should check Actions output and run smoke tests.

**Repo:** `https://github.com/memento-tech/oglasino-image-worker`
**Local path:** `/Users/igorstojanovic/Desktop/projects/Oglasino/oglasino-image-worker`

---

## What was built

Cloudflare Worker per the locked contract in `jobs/image_pipeline/IMAGE-PIPELINE-WORKER-CONTRACT.md`. TypeScript strict-mode (every guardrail flag on, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`). All 62 Vitest tests pass; `tsc --noEmit` clean.

### File layout

```
src/
├── index.ts                  route dispatch + top-level error guard
├── types.ts                  Env, Result<T,E>, WorkerError, JWT claim types
├── auth/
│   ├── jwt.ts                HS256 verify w/ dual-secret rotation fallback
│   └── adminAuth.ts          X-Backend-Auth constant-time compare (unused v1)
├── handlers/
│   ├── upload.ts             PUT /{key} — 10-step validation per §4.1
│   ├── view.ts               shared respond() for GET + HEAD (public+private)
│   ├── head.ts               re-export from view.ts (no behavior drift)
│   └── options.ts            CORS preflight
└── lib/
    ├── cors.ts               origin allowlist + Vercel suffix match
    ├── errors.ts             code→status table, JSON shape per §8.1
    ├── logger.ts             structured JSON to console.log per §10.2
    ├── pathValidation.ts     traversal + visibility (public/private/other)
    ├── rateLimit.ts          v1 stub — see "Decisions" below
    └── requestId.ts          UUID v4 generation/extraction per §10.4

test/  62 tests, integration via cloudflare:test SELF.fetch
```

### Endpoints (contract §4 — implemented)

| Method+path          | Auth                          | Notes                                                                 |
| -------------------- | ----------------------------- | --------------------------------------------------------------------- |
| `PUT /{key}`         | `x-upload-token` (upload JWT) | 10-step validation order, idempotent retry via `R2.head`              |
| `GET /public/{key}`  | none                          | `Cache-Control: public, max-age=31536000, immutable` + `Vary: Accept` |
| `GET /private/{key}` | `?token=<view JWT>`           | `Cache-Control: private, max-age=300`, key-prefix bound               |
| `HEAD /{key}`        | same as GET                   | headers only                                                          |
| `OPTIONS /*`         | n/a                           | CORS preflight                                                        |
| other paths          | n/a                           | 404 `OBJECT_NOT_FOUND`                                                |

### JWT verification (contract §5)

- HS256 only. Issuer enforced as `oglasino-backend`.
- `JWT_SIGNING_SECRET` tried first; falls back to `JWT_SIGNING_SECRET_PREVIOUS` ONLY on signature failure (not on expiry/issuer/scope errors).
- Distinct error codes: `TOKEN_EXPIRED`, `TOKEN_SIGNATURE_INVALID`, `TOKEN_ISSUER_INVALID`, `TOKEN_SCOPE_MISMATCH`, `TOKEN_KEY_MISMATCH`, `TOKEN_MALFORMED`.
- Claims sanity-checked beyond signature (upload tokens require `key`/`contentType`/`maxBytes`; view tokens require `keyPrefix`/`chatId`).

### CORS (contract §9)

- Allowlist parsed from `ALLOWED_ORIGINS` env var.
- Vercel preview suffix match: `https://oglasino-web-<alphanum>.vercel.app`.
- `Vary: Origin` on every CORS-affected response. Never echoes `*`.
- Allow-Credentials: false (header omitted).
- Preflight cache `Access-Control-Max-Age: 86400`.

### Logging (contract §10)

- Structured JSON to `console.log(JSON.stringify(...))`.
- Levels per §10.3: WARN for signature/scope/key/path-traversal failures, ERROR for R2 failures, INFO otherwise. Public GETs not logged (intentionally per §10.3).
- `x-request-id` generated (UUID v4) if not supplied; echoed in every response and every log line.

---

## Environment model & deployment

Two environments, no "dev" environment.

| Env        | Worker                    | Custom domain              | R2 bucket                 |
| ---------- | ------------------------- | -------------------------- | ------------------------- |
| staging    | `oglasino-images-staging` | `cdn-staging.oglasino.com` | `oglasino-images-staging` |
| production | `oglasino-images`         | `cdn.oglasino.com`         | `oglasino-images-prod`    |

Top-level `wrangler.toml` mirrors staging — `wrangler deploy` without `--env` never hits production.

### Branch → environment mapping

- `dev` → staging (auto-deploy via `.github/workflows/deploy.yml`)
- `main` → production (auto-deploy)
- Manual `workflow_dispatch` with environment selector also available

### Required GH Actions repository secrets (already configured by Igor)

- `CLOUDFLARE_API_TOKEN` — Cloudflare API token (Workers + R2 + Routes scopes)
- `CLOUDFLARE_ACCOUNT_ID`
- `JWT_SIGNING_SECRET_STAGING` / `JWT_SIGNING_SECRET_PROD`
- `BACKEND_SHARED_SECRET_STAGING` / `BACKEND_SHARED_SECRET_PROD`

The deploy workflow uses `cloudflare/wrangler-action@v3` `secrets:` input to push these to the Worker via `wrangler secret put` on every deploy. **Worker secrets are NOT pre-configured; they live as GH secrets and are pushed at deploy time.**

`JWT_SIGNING_SECRET_PREVIOUS` is intentionally NOT configured — added on first rotation only.

---

## Tests (62 passing)

Coverage:

- **JWT** (12 tests): valid, expired, wrong signature, wrong issuer, wrong scope (cross-scope), malformed, missing claims, dual-secret fallback success + failure.
- **Path validation** (13 tests): `..`, percent-encoded `..`, backslash, double-slash, single-dot segment, empty key, excessively long key, forbidden chars, visibility classifier.
- **CORS** (7 tests): allowed origin echoed, disallowed not echoed, Vercel preview suffix accepted, attacker preview rejected, no `*`, x-request-id minted/echoed.
- **Upload** (10 tests): happy path + each error code (`TOKEN_MISSING`, `PATH_TRAVERSAL`, `TOKEN_KEY_MISMATCH`, `CONTENT_TYPE_MISMATCH`, `FILE_TOO_LARGE`, `CONTENT_TYPE_NOT_ALLOWED`, `TOKEN_EXPIRED`, `TOKEN_SIGNATURE_INVALID`) + idempotent retry verifying ETag stable on the second PUT.
- **View** (13 tests): public 200/404, private 200/400/401/403/404, key prefix mismatch, HEAD with no body, method-not-allowed (POST/DELETE 405).
- **Admin auth** (7 tests): missing/wrong/correct header, timingSafeEqual.

Run with `npm test`; lint with `npm run lint`.

---

## Decisions / deviations

1. **No Worker-level rate limiting in v1** (per WORKER_PROMPT decision).

   - Backend already gates issuance via Bucket4j (60/min/user, contract §11.4); upload JWTs are short-TTL and bound to a single key+content-type+maxBytes.
   - `lib/rateLimit.ts` is a stub returning `ok` always, with the call sites already plumbed (`jti`, `ip` available). Adding KV/Durable Object backing later is non-breaking.
   - Documented in README "Known gaps".

2. **No magic-byte content-type sniffing** — deferred per contract §13.4. Worker trusts the `Content-Type` header against the JWT `contentType` claim.

3. **Path traversal at the dispatch layer** — the WHATWG URL parser used by Workers normalizes `..`, `%2e%2e`, and `\` away before the Worker sees them. `validateKey` still rejects these inputs (defense-in-depth, covered by unit tests against the validator directly), but the realistic attack vector at the dispatch layer is forbidden characters (e.g. spaces becoming `%20`), which the validator rejects.

4. **No PR for review** — user opted at the end to push directly to `main` and `dev` rather than do PR review.

5. **`worker.js` (legacy) deleted** — was never tracked in this repo's history.

---

## What backend agent should rely on

- **Endpoints** are exactly the three listed above. PUT key matches JWT `key` claim **byte-for-byte** (contract §4.1 step 6); backend signs with the full key including prefix.
- **JWT structure** matches §5.1 (upload) and §5.2 (view) exactly. `iss` MUST be `"oglasino-backend"`. Worker rejects others with `TOKEN_ISSUER_INVALID`.
- **`JWT_SIGNING_SECRET` must be byte-identical between Worker and backend** for each environment. Provisioned via the GH Actions secret pair (`_STAGING`, `_PROD`); backend must use the matching value.
- **`maxBytes` claim** is per-token, capped by the Worker's `MAX_UPLOAD_BYTES` env (10 MB default). Backend can issue smaller per-scope limits.
- **`x-request-id`** is echoed in every Worker response (header). Backend should capture it on outgoing Worker calls and put it in MDC alongside backend's own request id.

---

## What frontend agent should rely on

- **Public URLs:** `https://cdn.oglasino.com/{key}` (Image Resizing variants via `/cdn-cgi/image/...` work transparently; Worker doesn't see those requests).
- **Private URLs:** `https://cdn.oglasino.com/{key}?token={view-jwt}`. Token is URL-safe base64 from `jose`; URL-encode if you're paranoid (single-call endpoints are fine without).
- **CORS allowlist** is configured for `oglasino.com`, `www.oglasino.com`, `oglasino-web.vercel.app`, Vercel preview suffix `oglasino-web-*.vercel.app`, and `localhost:3000` / `localhost:3001` in staging only. Production strips localhost.
- **Error responses** always have `{error: {code, message, details?, retryable}}` JSON. The `code` is stable; localize on it.

---

## Open items / handoff

| Item                                           | Owner               | Notes                                                                                                                    |
| ---------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Verify both deploys succeeded                  | orchestrator / Igor | Check `https://github.com/memento-tech/oglasino-image-worker/actions`. Both runs kicked off when main + dev were pushed. |
| Run smoke tests against staging + prod         | orchestrator / Igor | Commands in README "Smoke-test after deploy". I did not execute these.                                                   |
| Bind custom domains                            | Igor (already done) | `cdn-staging.oglasino.com` + `cdn.oglasino.com` per the WORKER_PROMPT update                                             |
| Backend implementation (Track 1)               | backend agent       | Phase B in contract §17.2 — depends on this Worker being live                                                            |
| Frontend implementation (Tracks 2-4)           | frontend agent      | Phase C in contract §17.3 — depends on backend                                                                           |
| Cleanup branch `feat/initial-worker` on remote | optional            | Redundant; same commit as main + dev                                                                                     |

## What did NOT happen

- I did not run `wrangler deploy` myself — CI does that on push.
- I did not verify the deployed Worker responds correctly. The deploys were triggered by the pushes; success/failure is visible in GH Actions.
- I did not run any post-deploy smoke tests against the live URLs.
- I did not open a GitHub PR (no `gh` CLI available, and the user later opted to push directly to `main` + `dev` instead).
- I did not bind custom domains, create R2 buckets, or configure any GH secrets — Igor did all of that.
- I did not implement React Native, frontend, or backend changes — those are separate tracks per contract §17.
