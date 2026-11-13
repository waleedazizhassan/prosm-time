import { defineConfig } from "vitest/config";

// PROSM Connect: the private Realtime channels, against a local Supabase (see supabase/tests-realtime).
export default defineConfig({
  test: {
    include: ["supabase/tests-realtime/**/*.test.ts"],
    environment: "node",
    testTimeout: 60000,
  },
});
