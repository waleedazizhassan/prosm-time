import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// PROSM Time's own Supabase client - its own project, own URL, own anon
// key (VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY, §43.5: "never reuse
// credentials, project refs, or connection strings from PROSM Platform
// or PROSM Management"). Mirrors PROSM Platform's own
// src/core/api/supabaseClient.js singleton shape exactly - same shared
// domain convention, independent implementation per product.
let supabaseClient: SupabaseClient | null = null;

// § real bug, widened root-cause fix (2026-09-15, user-reported blank
// Dashboard on poor/degraded connectivity). AuthContext.tsx's own
// loadProfile() already got a one-off Promise.race timeout for its two
// calls (2026-09-13's own fix) - but that was a local patch to ONE call
// site, not the actual root cause: plain `fetch()` against an
// unreachable host can hang far longer than users will wait (sometimes
// minutes, depending on OS/network stack) rather than rejecting
// quickly, and EVERY other repository call in this app (ClockInOutCard's
// own session/sites/presence load, AdminOverviewCard, ExceptionsCard,
// every other screen) awaits its Supabase call with no timeout of its
// own. A hung fetch there means `loading` never flips to false, and
// this app's own established pattern is `if (loading) return null` -
// so the whole card (and everything after it in the tree) renders
// nothing, forever, with no error, exactly the reported blank screen.
//
// Real fix: a global fetch timeout at the CLIENT level, not another
// one-off `Promise.race` per call site - every request through this
// one client (every repository, every screen, current and future) gets
// the same protection automatically. 20s is generous enough for a
// slow-but-working connection, short enough that a genuinely dead
// connection fails fast into each repository's own existing try/catch
// (already returns {success:false}, never throws further) instead of
// hanging indefinitely.
const FETCH_TIMEOUT_MS = 20000;

function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  // A caller-supplied signal (Supabase's realtime/auth internals
  // sometimes pass their own) must still be respected - abort on
  // whichever fires first, exactly like AbortSignal.any would, without
  // requiring the newer API's runtime support.
  const callerSignal = init?.signal;
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timeoutId));
}

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
      fetch: fetchWithTimeout,
    },
  });

  return supabaseClient;
}

export function requireSupabaseClient(): SupabaseClient {
  return getSupabaseClient();
}
