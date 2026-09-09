import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// PROSM Time - standalone Vite config, independent from PROSM
// Platform's own build. See docs/PROSM_TIME_IMPLEMENTATION_MASTER_FILE_V3.md
// §43.5: "never reuse credentials, project refs, or connection strings
// from PROSM Platform or PROSM Management."
//
// Hardening (see docs/SECURITY_HARDENING.md): the shipped bundle carries
// no source maps, no comments and no developer conveniences. Application
// behaviour is unchanged - only the readability of the output is.
export default defineConfig({
  plugins: [react()],
  build: {
    // Never ship a map of the original sources with the product.
    sourcemap: false,
    minify: "terser",
    terserOptions: {
      compress: {
        // Developer conveniences must not survive into a release build.
        drop_console: true,
        drop_debugger: true,
        passes: 2,
      },
      // Identifier mangling only. Property mangling is deliberately NOT
      // enabled: it would rename Supabase/Capacitor payload keys and
      // change behaviour.
      mangle: true,
      format: {
        comments: false,
      },
    },
    rollupOptions: {
      output: {
        // Opaque, content-hashed file names - no module paths leak
        // through the asset manifest.
        entryFileNames: "assets/[hash].js",
        chunkFileNames: "assets/[hash].js",
        assetFileNames: "assets/[hash][extname]",
      },
    },
  },
  esbuild: {
    legalComments: "none",
  },
});
