import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        singleWorker: true,
        // Disable per-test storage isolation. There's an open
        // miniflare/vitest-pool-workers bug where the snapshot pop logic
        // chokes on SQLite -shm/-wal files for R2 buckets. Tests work
        // around this by writing to unique keys and not relying on a clean
        // bucket between tests.
        isolatedStorage: false,
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // Override secrets just for tests. Production secrets are set via
          // `wrangler secret put`; these are deterministic so signed JWTs
          // verify and constant-time compare tests are stable.
          bindings: {
            JWT_SIGNING_SECRET: "test-jwt-signing-secret-32-bytes-min-yes",
            BACKEND_SHARED_SECRET: "test-backend-shared-secret-32b-min-please",
          },
        },
      },
    },
  },
});
