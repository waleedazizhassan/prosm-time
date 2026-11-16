// connect-ice - PROSM Connect phase G (owner 2026-11-15: calls connect but carry no sound or picture; zero cost).
// Gives a signed-in person the ICE servers for a call or a small meeting: Google STUN always, and the free TURN relays
// configured as Supabase secrets - never in the app's code:
//   TURN_1_URLS (comma-separated turn:/turns: URLs), TURN_1_USERNAME, TURN_1_CREDENTIAL   e.g. ExpressTURN (free, no card)
//   TURN_2_URLS, TURN_2_USERNAME, TURN_2_CREDENTIAL                                      e.g. Metered (free, no card)
//   METERED_APP (the app's subdomain), METERED_API_KEY                                   or Metered's per-request credentials
// Metered issues its own credentials per request; a relay that does not answer is skipped (the call still tries STUN).
// Free plans without a card stop when their monthly allowance is used - they cannot bill.
//
// TURN bandwidth strategy (owner 2026-11-16): P2P first - the app always tries the direct path (STUN) and the relays
// are only a fallback chosen by ICE itself. Each relay has a monthly quota (TURN_1_QUOTA_MB, TURN_2_QUOTA_MB,
// METERED_QUOTA_MB; 500 MB when not set). What the relays carried is what the apps reported (connect_turn_usage):
//   50 % a mark is logged, 75 % the platform is warned, 90 % a critical warning, 95 % that relay is no longer handed
//   out for NEW calls - direct calls and the other relay go on; a call already talking keeps its relay (its
//   credentials were already given). Warnings are written once a month per level (connect_turn_alerts) and e-mailed
//   to TURN_ALERT_EMAIL when that secret is set.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders, errorResponse, successResponse } from "../_shared/http.ts";
import { sendEmail } from "../_shared/emailService.ts";

const STUN: RTCIceServer = { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] };
const DEFAULT_QUOTA_MB = 500;
const LEVELS = [50, 75, 90, 95] as const;

interface RTCIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}
interface Relay {
  server: RTCIceServer;
  key: string; // the relay's host name - what the app reports from its connection
  quotaBytes: number;
}

/** turn:host:port?transport=udp -> host (lower case) - the same rule as the app's usage meter */
function relayHost(url: string): string {
  return url.replace(/^turns?:/i, "").replace(/^\/\//, "").split("?")[0].replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
}
const firstUrl = (s: RTCIceServer) => (Array.isArray(s.urls) ? s.urls[0] : s.urls) ?? "";
const quota = (name: string) => {
  const mb = Number(Deno.env.get(name));
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_QUOTA_MB) * 1024 * 1024;
};

async function meteredServers(): Promise<Relay[]> {
  const app = Deno.env.get("METERED_APP");
  const key = Deno.env.get("METERED_API_KEY");
  if (!app || !key || !/^[a-z0-9-]+$/i.test(app)) return [];
  try {
    const response = await fetch(`https://${app}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return [];
    const list = await response.json();
    const servers: RTCIceServer[] = Array.isArray(list) ? list.filter((s) => s && (typeof s.urls === "string" || Array.isArray(s.urls))) : [];
    return servers.filter((s) => /^turns?:/i.test(firstUrl(s))).map((s) => ({ server: s, key: relayHost(firstUrl(s)), quotaBytes: quota("METERED_QUOTA_MB") }))
      .concat(servers.filter((s) => !/^turns?:/i.test(firstUrl(s))).map((s) => ({ server: s, key: "", quotaBytes: Infinity })));
  } catch {
    return [];
  }
}

// TURN_1_* and TURN_2_* - two relays with fixed credentials (e.g. ExpressTURN and Metered); either may be absent
function staticServers(): Relay[] {
  const relays: Relay[] = [];
  for (const n of [1, 2]) {
    const urls = (Deno.env.get(`TURN_${n}_URLS`) ?? "").split(",").map((u) => u.trim()).filter((u) => /^turns?:/i.test(u));
    const username = Deno.env.get(`TURN_${n}_USERNAME`);
    const credential = Deno.env.get(`TURN_${n}_CREDENTIAL`);
    if (urls.length > 0 && username && credential) relays.push({ server: { urls, username, credential }, key: relayHost(urls[0]), quotaBytes: quota(`TURN_${n}_QUOTA_MB`) });
  }
  return relays;
}

/** Drops relays at 95 % of their monthly quota and records / sends the 50-75-90-95 % marks. Never blocks the call. */
async function guard(relays: Relay[]): Promise<RTCIceServer[]> {
  const counted = relays.filter((r) => r.key && Number.isFinite(r.quotaBytes));
  if (counted.length === 0) return relays.map((r) => r.server);
  try {
    const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const keys = [...new Set(counted.map((r) => r.key))];
    const { data, error } = await service.rpc("prosm_time_connect_relay_month", { p_servers: keys });
    if (error) return relays.map((r) => r.server);
    const used = new Map<string, number>((data ?? []).map((row: { server: string; used_bytes: number }) => [row.server, Number(row.used_bytes)]));
    const kept: RTCIceServer[] = [];
    for (const relay of relays) {
      if (!relay.key || !Number.isFinite(relay.quotaBytes)) { kept.push(relay.server); continue; }
      const bytes = used.get(relay.key) ?? 0;
      const pct = (bytes / relay.quotaBytes) * 100;
      for (const level of LEVELS) {
        if (pct < level) continue;
        const { data: first } = await service.rpc("prosm_time_connect_mark_alert", { p_server: relay.key, p_level: level, p_used: Math.round(bytes), p_quota: Math.round(relay.quotaBytes) });
        if (first === true) {
          console.warn(`[connect-ice] relay ${relay.key} at ${level}% of its monthly quota (${Math.round(bytes / 1048576)} / ${Math.round(relay.quotaBytes / 1048576)} MB)`);
          const to = Deno.env.get("TURN_ALERT_EMAIL");
          if (to && level >= 75) {
            await sendEmail({
              to,
              subject: `PROSM Connect - relay ${relay.key} at ${level}% of its monthly allowance`,
              html: `<p>The relay <b>${relay.key}</b> has carried ${Math.round(bytes / 1048576)} MB of its ${Math.round(relay.quotaBytes / 1048576)} MB this month (${level}%).</p>` +
                (level >= 95 ? "<p>New calls no longer use it; direct calls and the other relay go on. Calls already talking are not cut.</p>" : "<p>Calls still use it.</p>"),
              purpose: "connect_turn_alert",
              supabase: service,
            }).catch(() => undefined);
          }
        }
      }
      if (pct < 95) kept.push(relay.server);
    }
    return kept;
  } catch {
    return relays.map((r) => r.server);
  }
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

    const relays = await guard([...staticServers(), ...(await meteredServers())]);
    // STUN first: the direct path is always tried; ICE falls back to a relay only when no direct path works, and
    // tries every relay given here (a relay that fails is simply not used - the other one is)
    return successResponse({ iceServers: [STUN, ...relays], relay: relays.length > 0 });
  } catch {
    return successResponse({ iceServers: [STUN], relay: false });
  }
});
