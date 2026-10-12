import { defineConfig } from "vitest/config";

// Database suites: a real PostgreSQL (PGlite) built from every
// migration, so they run in node, one file at a time, with long timeouts.
export default defineConfig({
  test: {
    environment: "node",
    include: ["supabase/tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 600_000,
  },
});
