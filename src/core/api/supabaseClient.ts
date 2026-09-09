import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { installationHeaders } from "../license/installationIdentity";

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
    global: {
      // Every Edge Function call carries this installation's identity, so the
      // server can recognise the installation behind a protected operation.
      // The identity is issued and verified server-side; attaching it here is
      // transport only, never a permission.
      fetch: (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (!url.includes("/functions/v1/")) {
          return fetch(input as RequestInfo, init);
        }
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        for (const [name, value] of Object.entries(installationHeaders())) {
          if (!headers.has(name)) headers.set(name, value);
        }
        return fetch(input as RequestInfo, { ...init, headers });
      },
    },
  });

  return supabaseClient;
}

export function requireSupabaseClient(): SupabaseClient {
  return getSupabaseClient();
}
