// Tells the TS compiler that `env` from `cloudflare:test` has the shape of
// our Worker's Env. The actual values come from wrangler.toml + the
// vitest.config.ts miniflare bindings override.

import type { Env } from "../src/types.ts";

declare module "cloudflare:test" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ProvidedEnv extends Env {}
}
