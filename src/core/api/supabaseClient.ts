import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// PROSM Time's own Supabase client - its own project, own URL, own anon
// key (VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY, §43.5: "never reuse
// credentials, project refs, or connection strings from PROSM Platform
// or PROSM Management"). Mirrors PROSM Platform's own
// src/core/api/supabaseClient.js singleton shape exactly - same shared
// domain convention, independent implementation per product.
let supabaseClient: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (supabaseClient) {
    return supabaseClient;
  }

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Missing Supabase environment variables.");
  }

  supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });

  return supabaseClient;
}

export function requireSupabaseClient(): SupabaseClient {
  return getSupabaseClient();
}
