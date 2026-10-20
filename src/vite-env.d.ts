/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  // "true" when the Android build includes google-services.json (set by CI).
  readonly VITE_FIREBASE_CONFIGURED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
