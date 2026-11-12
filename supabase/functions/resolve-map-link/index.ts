// resolve-map-link - owner 2026-11-12: "when I add a work site I can paste a map link someone sent me".
// A short shared Google Maps link (maps.app.goo.gl/…, goo.gl/maps/…) carries no position until it is
// opened; the browser cannot follow it (no CORS), so this follows its redirects for a signed-in member
// and returns the final address only. Only Google's own short-link hosts are accepted, every hop must
// stay on a Google host (no open proxy), at most 5 hops, 5 seconds each, nothing else is fetched.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders, errorResponse, successResponse } from "../_shared/http.ts";

const SHORT_HOSTS = new Set(["maps.app.goo.gl", "goo.gl", "g.co"]);
const isGoogleHost = (host: string) =>
  SHORT_HOSTS.has(host) || host === "google.com" || host.endsWith(".google.com") || /^(www\.|maps\.)?google\.[a-z.]{2,6}$/.test(host);

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

    const body = await request.json().catch(() => ({}));
    const raw = typeof body?.url === "string" ? body.url.trim() : "";
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      return errorResponse("Not a link.", 400, "INVALID_LINK");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return errorResponse("Not a link.", 400, "INVALID_LINK");
    if (!SHORT_HOSTS.has(url.hostname.toLowerCase())) return errorResponse("Only Google Maps short links.", 400, "NOT_A_MAP_LINK");

    let current = url;
    for (let hop = 0; hop < 5; hop++) {
      const response = await fetch(current.toString(), { method: "GET", redirect: "manual", signal: AbortSignal.timeout(5000) });
      const next = response.headers.get("location");
      await response.body?.cancel();
      if (!next || response.status < 300 || response.status >= 400) break;
      const target = new URL(next, current);
      if (!isGoogleHost(target.hostname.toLowerCase())) return errorResponse("The link leaves Google Maps.", 400, "NOT_A_MAP_LINK");
      current = target;
    }
    return successResponse({ url: current.toString() });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Could not open the link.", 500, "RESOLVE_FAILED");
  }
});
