/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  // "true" when the Android build includes google-services.json (set by CI).
  readonly VITE_FIREBASE_CONFIGURED?: string;
  // v2.3.55: "play" for the Google Play build (updates go through Play)
  readonly VITE_DISTRIBUTION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
