import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// PROSM Time - standalone Vite config, independent from PROSM
// Platform's own build. See docs/PROSM_TIME_IMPLEMENTATION_MASTER_FILE_V3.md
// §43.5: "never reuse credentials, project refs, or connection strings
// from PROSM Platform or PROSM Management."
//
// `base` defaults to root ("/") - correct for the Electron build
// (electron-serve treats dist/ as its own web root under a custom
// protocol) and the Capacitor Android build (same: dist/ is copied
// into the app and served as the WebView's own root), so root-relative
// asset paths already resolve correctly there. Only the GitHub Pages
// deployment (release.yml's deploy-web job) needs a real sub-path
// base - it sets VITE_BASE_PATH before building, nothing else should.
export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/",
  plugins: [react()],
});
