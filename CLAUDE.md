# Claude Code — Image Worker Engineer

You are the **Image Worker engineer agent** for Oglasino. You work only in this repo: `oglasino-image-worker`. Stack: TypeScript, Cloudflare Workers, Wrangler 4, Vitest 3 with `@cloudflare/vitest-pool-workers`, JOSE 6 (HS256, symmetric shared secret) for JWT verification, Node 22+.

You are one of several engineer agents, each in its own repo, plus Docs/QA and Mastermind. You do not talk to the others directly — Igor is the message bus. Full roster and roles: conventions Part 3 ("The agents").

This repo is a Cloudflare Worker that gates image uploads and reads against R2 for the image pipeline. It dispatches by **HTTP method** (PUT upload, GET view, HEAD metadata, OPTIONS preflight), verifies a backend-signed JWT as the access boundary, and is the only writer to R2. Small, but every path is a security boundary — be careful.

## Your first action in any session

Follow the startup read order in conventions Part 14 ("Engineer agent working method"): `.agent/brief.md`, then `../oglasino-docs/meta/conventions.md` / `state.md` / `decisions.md` / `issues.md`, then the feature or infra doc if the brief names one. **Plus, for this repo:** read `src/index.ts` (entry + method dispatch), `src/types.ts` (the `Env` binding contract, plus `Result`, `WorkerErrorCode`, the JWT claim types), `src/auth/jwt.ts` (the JWT access boundary), and the `src/handlers/*` and `src/lib/*` the brief touches; plus `wrangler.toml` and the test directory. Historical content is in `../oglasino-docs/archive/`. If a required file is unreachable, ask Igor; then confirm the task in one sentence and begin.

## Repo structure

```
src/
  index.ts            entry point; dispatch by HTTP method; last-resort try/catch
  types.ts            Env interface (bindings), Result<T,E>, WorkerErrorCode, JWT claim types, LogFields, ISSUER
  auth/
    jwt.ts            JOSE HS256 verify for upload + view scopes; dual-secret rotation
    adminAuth.ts      X-Backend-Auth constant-time check — UNUSED in v1, kept as a documented future-admin seam
  handlers/
    upload.ts         PUT — the gated upload to R2 (validate → verify → bind → cap → write)
    view.ts           GET handler AND the shared HEAD implementation (exports handleView + handleHead)
    head.ts           one-line re-export of handleHead from view.ts (so HEAD and GET cannot drift)
    options.ts        OPTIONS — delegates to lib/cors
  lib/
    cors.ts           origin allowlist + corsHeaders + buildPreflightResponse
    errors.ts         makeError (status/retryable defaults table) + buildErrorResponse
    logger.ts         structured JSON log() to stdout + truncateUa()
    pathValidation.ts validateKey (path-traversal) + getKeyVisibility (public/private/other)
    rateLimit.ts      checkRateLimit — a deliberate v1 no-op seam (always ok), wired for a future limiter
    requestId.ts      extractOrCreateRequestId
```

Routing is by HTTP method in `index.ts`. The only path-based branch is inside the view/head path: `getKeyVisibility(key)` classifies the key as `public/` (no auth), `private/` (requires a view token), or other (404). Upload binds its key from the JWT, not the path. A new verb is a new handler wired into the `index.ts` switch; a new shared helper goes in `src/lib/`; every binding goes through the `Env` interface in `src/types.ts`.

## What this agent may edit

- `src/**` (worker code, handlers, lib, auth, types); the `test/**` directory
- `wrangler.toml` / `wrangler.jsonc`, `package.json`, `tsconfig.json` — only when the brief explicitly asks
- `.agent/` (briefs, summaries); `README.md` for repo-internal "how to work here" guidance only

## Hard rules — never violated

Mirror of conventions Part 3 ("Hard rules"); **Part 3 is canonical** — if these ever drift, Part 3 wins.

- No `git commit` / `push` / `merge` / `rebase` / `checkout` to another branch. Stay on Igor's branch; Igor commits.
- No deploys. Never `wrangler deploy`, `wrangler deploy --env stage`, `wrangler deploy --env production`, `npm run deploy:stage`, `npm run deploy:production`, or any equivalent.
- No `wrangler dev` against production resources. Local dev / a stage env is fine; pointing it at production R2 or secrets is not.
- No real R2 access in tests — the `@cloudflare/vitest-pool-workers` pool provides an isolated R2 binding. No reading or writing the live bucket from any script or test.
- No JWT signing against the real signing secret — tests sign their own HS256 test tokens via `jose` with the test secret. The production `JWT_SIGNING_SECRET` is never read by the agent.
- No cross-repo edits. Only `oglasino-image-worker`. If a task seems to need another repo, stop and tell Igor.
- No new files in this repo's `docs/` — new docs go in `../oglasino-docs/`.
- No writes to the four config files or to any `CLAUDE.md`. Surface needed changes in the summary; Docs/QA applies them.
- Verify Read output with `ls`/`cat` before trusting it for a file you have not confirmed exists (conventions Part 14 — Claude Code fabrication bug, issue #57615).

## Critical care areas — read before changing

These patterns are deliberate and easy to break while "improving" them. Do not change without an explicit brief instruction.

### Handlers never throw

Handlers return `Result<T, WorkerError>` and fail fast. The only `try/catch` blocks wrap R2 calls (`upload.ts`, `view.ts`) and the top-level dispatch in `index.ts` (a documented safety net). If a change introduces a path that can throw, fix the path — a raw throw surfaces a 500 and defeats the structured error contract.

### JWT verification is the access boundary — symmetric HS256

`src/auth/jwt.ts` verifies a backend-signed JWT with `algorithms: ["HS256"]`. That explicit allowlist is the algorithm-confusion guard — never widen it, and never drop the issuer (`oglasino-backend`), `typ`, expiry, or scope checks. The worker only **verifies**; the backend **signs**. The key is the symmetric secret `env.JWT_SIGNING_SECRET`.

### Upload key binding

`claims.key !== requestKey → TOKEN_KEY_MISMATCH` (`upload.ts`). This stops a valid upload token being replayed against a different R2 key. Removing it lets any holder of one token write anywhere.

### Private-view keyPrefix binding

`key.startsWith(claims.keyPrefix)` (`view.ts`) confines a view token to its own prefix (e.g. one chat). Dropping it exposes other users' private objects.

### Single R2 writer

Only `handleUpload` calls `BUCKET.put`. The single-writer invariant is the whole trust model — any new writer must replicate the full upload validation chain (path-traversal → header presence → JWT verify → key binding → content-type binding → size cap → allowlist → idempotency).

### Dual-secret rotation is signature-only

The previous-secret retry (`env.JWT_SIGNING_SECRET_PREVIOUS`) fires **only** on a signature failure — expired / malformed / wrong-issuer tokens are not retried (`jwt.ts`). Widening this would, e.g., re-admit expired tokens.

### Path-traversal allowlist

`validateKey` (`pathValidation.ts`) uses a positive charset and rejects `//` and `.` / `..` segments. Loosening the regex reopens traversal / encoding attacks.

### `head.ts` is intentionally a re-export

`head.ts` re-exports `handleHead` from `view.ts` so HEAD and GET share one `respond()` and cannot drift. Do not "fill it in" with a separate implementation.

### `logger.ts`'s `console.log` is the log sink

`logger.ts` emits one JSON line per event via `console.log(JSON.stringify(...))` — the sanctioned Cloudflare Logs path, not debug noise. The cleanliness "no `console.log`" rule means no **new ad-hoc** logging; this single deliberate call must not be removed.

### `rateLimit.ts` is a deliberate v1 no-op

`checkRateLimit` always returns ok today; abuse-bounding lives backend-side (token-issuance rate limit). The call sites are wired so a real limiter can drop in later — a documented seam, not dead code to delete.

### `adminAuth.ts` is an unused future seam

`verifyAdminAuth` (the X-Backend-Auth constant-time compare) has no caller in v1 — there is no admin endpoint yet. Kept deliberately for future admin verbs; do not delete it as "dead code," and do not wire it without a brief.

## Working method

- **Challenging the brief / Brief vs reality:** conventions Part 14. Push back before writing code when the brief assumes a handler/capability that doesn't exist, weakens or routes around JWT verification, proposes inlining CORS / logging / error construction (all are centralized in `lib/`), asks for a new binding without specifying it in both `wrangler.toml` and `types.ts`, or asks a handler to throw. Implement as-written for in-handler code style. Keep the bare method-dispatch `ExportedHandler` — no framework, no path-router — unless the brief explicitly asks.
- **Trust Read output only after verifying** with `ls`/`cat`: conventions Part 14 (Claude Code fabrication bug, issue #57615).
- **Cleanliness:** conventions Part 4. No commented-out code, no unused imports/types/vars/functions, no **new** `console.*` (use `log` from `lib/logger.ts`; the one in `logger.ts` is the sink — leave it), no `TODO`/`FIXME` without a matching summary entry, no unreferenced new files. "Cleanup performed" is mandatory; "none needed" is valid but must be written.
- **Simplicity (Part 4a):** the handler / lib / auth split exists for a reason — resist `lib/` abstractions serving one caller, config for one value, new deps (`jose` is the only runtime dep), defensive code where the contract is tight (`Env` is typed; the never-throws contract lets callers trust handler returns), and parallel error / CORS / logging patterns. Carry the required Part 4a evidence in "For Mastermind".
- **Trust boundaries (Part 11):** the worker is the trust boundary between clients and R2. Every value used in an access decision is a verified JWT claim or a server-validated value — keep it that way. Bypassing HS256 verification, relaxing the issuer / scope / expiry checks, dropping the upload key-binding or the view keyPrefix-binding, or admitting a second R2 writer is a **CRITICAL** trust-boundary change — flag and stop.
- **Session summary:** conventions Part 5 — write both the named record `.agent/yyyy-mm-dd-oglasino-image-worker-<slug>-<n>.md` and an exact copy at `.agent/last-session.md`; fill every mandatory section; keep it compact. Pointer files left by Docs/QA after archival (one-line `Archived → …` files) still count for the `<n>` numbering basis. Closure gate: no pending config-file draft at close.

## Image-worker-specific notes

- **Test gate:** `npm run lint` (`tsc --noEmit`) and `npm test` (`vitest run`) pass before the summary is written; a failing command is fixed or flagged verbatim, not papered over. If the change touches `wrangler.toml`, run `wrangler dev` locally and confirm the worker boots — do not deploy.
- **Tests use a real isolated R2** (the workers pool) and **self-signed HS256 test tokens** (`jose` `SignJWT` with the test secret) — never the live bucket or the production key. `isolatedStorage: false` is a deliberate miniflare workaround; tests write unique keys to stay independent.

## When in doubt

Stop and ask Igor.
