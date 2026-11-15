// connect-ice - PROSM Connect phase G (owner 2026-11-15: calls connect but carry no sound or picture; zero cost).
// Gives a signed-in person the ICE servers for a call or a small meeting: Google STUN always, and the free TURN relays
// configured as Supabase secrets - never in the app's code:
//   TURN_1_URLS (comma-separated turn:/turns: URLs), TURN_1_USERNAME, TURN_1_CREDENTIAL   e.g. ExpressTURN (free, no card)
//   TURN_2_URLS, TURN_2_USERNAME, TURN_2_CREDENTIAL                                      e.g. Metered (free, no card)
//   METERED_APP (the app's subdomain), METERED_API_KEY                                   or Metered's per-request credentials
// Metered issues its own credentials per request; a relay that does not answer is skipped (the call still tries STUN).
// Free plans without a card stop when their monthly allowance is used - they cannot bill.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders, errorResponse, successResponse } from "../_shared/http.ts";

const STUN: RTCIceServer = { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] };

interface RTCIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

async function meteredServers(): Promise<RTCIceServer[]> {
  const app = Deno.env.get("METERED_APP");
  const key = Deno.env.get("METERED_API_KEY");
  if (!app || !key || !/^[a-z0-9-]+$/i.test(app)) return [];
  try {
    const response = await fetch(`https://${app}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return [];
    const list = await response.json();
    return Array.isArray(list) ? list.filter((s) => s && (typeof s.urls === "string" || Array.isArray(s.urls))) : [];
  } catch {
    return [];
  }
}

// TURN_1_* and TURN_2_* - two relays with fixed credentials (e.g. ExpressTURN and Metered); either may be absent
function staticServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [];
  for (const n of [1, 2]) {
    const urls = (Deno.env.get(`TURN_${n}_URLS`) ?? "").split(",").map((u) => u.trim()).filter((u) => /^turns?:/i.test(u));
    const username = Deno.env.get(`TURN_${n}_USERNAME`);
    const credential = Deno.env.get(`TURN_${n}_CREDENTIAL`);
    if (urls.length > 0 && username && credential) servers.push({ urls, username, credential });
  }
  return servers;
}

serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return errorResponse("Method not allowed.", 405, "METHOD_NOT_ALLOWED");
  try {
    const authorization = request.headers.get("authorization");
    if (!authorization) return errorResponse("Missing Authorization header.", 401, "UNAUTHORIZED");
    const caller = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: authorization } },
    });
    const { data: who } = await caller.auth.getUser();
    if (!who?.user) return errorResponse("Not signed in.", 401, "UNAUTHORIZED");
    // a person asks once per call or meeting - 60 an hour is plenty, and keeps the free allowance from abuse
    const { data: allowed, error: limitError } = await caller.rpc("prosm_time_take_rate_limit", { p_action: "connect-ice", p_max: 60, p_window_seconds: 3600 });
    if (limitError || allowed !== true) return successResponse({ iceServers: [STUN], relay: false });

    const relays = [...staticServers(), ...(await meteredServers())];
    return successResponse({ iceServers: [STUN, ...relays], relay: relays.length > 0 });
  } catch {
    return successResponse({ iceServers: [STUN], relay: false });
  }
});
