# Migration: `dev` → `stage`

This PR renames the staging-deploy branch from `dev` to `stage` and
standardizes env-label words (`staging` → `stage`, `STAGING` → `STAGE`)
across code/config/docs in this repo. The PR is **code-only** — no
deployed Cloudflare resources are renamed (Worker name, R2 bucket, and
`cdn-staging.oglasino.com` custom domain stay as-is).

After this PR merges, Igor must complete these manual steps before the
new `stage` branch will deploy.

## 1. Local + remote branch rename

```bash
# From a clean working tree, with `dev` branch up to date with origin/dev
git checkout dev
git pull
git branch -m dev stage
git push origin -u stage
git push origin --delete dev
```

## 2. GitHub UI

**Settings → Branches** (branch protection)
- If any rule references `dev`, edit it to reference `stage`. (If no
  rules exist for `dev`, nothing to do.)

**Settings → Secrets and variables → Actions** (GitHub doesn't support
rename — delete the old, recreate with the new name and the same value)
- `JWT_SIGNING_SECRET_STAGING` → `JWT_SIGNING_SECRET_STAGE`
- `BACKEND_SHARED_SECRET_STAGING` → `BACKEND_SHARED_SECRET_STAGE`

**Settings → Environments**
- If a GH Actions environment named `staging` exists (used by
  `deploy.yml`'s `environment: name:` block), rename it to `stage` (or
  delete + recreate). The workflow now references `stage`.

## 3. Verify next deploy

Push a small change to the `stage` branch and confirm:
- `.github/workflows/deploy.yml` triggers
- It deploys to the existing stage Worker (`oglasino-images-staging`)
  with the existing R2 bucket — no new Cloudflare resources should be
  created
- `wrangler deploy --env stage` runs clean

## Cleanup

Delete `MIGRATION-NOTES.md` in the next PR after Igor confirms the
rename completed cleanly.
