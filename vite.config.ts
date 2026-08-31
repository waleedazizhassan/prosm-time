import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// PROSM Time - standalone Vite config, independent from PROSM
// Platform's own build. See docs/PROSM_TIME_IMPLEMENTATION_MASTER_FILE_V3.md
// §43.5: "never reuse credentials, project refs, or connection strings
// from PROSM Platform or PROSM Management."
export default defineConfig({
  plugins: [react()],
});
