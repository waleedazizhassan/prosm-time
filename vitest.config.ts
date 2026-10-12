import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["./src/testSetup.ts"],
      css: false,
      // Database suites run separately: npm run test:db
      exclude: ["**/node_modules/**", "supabase/**"],
    },
  })
);
