// resolve-map-link - owner 2026-11-12: "when I add a work site I can paste a map link someone sent me".
// A short shared Google Maps link (maps.app.goo.gl/…, goo.gl/maps/…) carries no position until it is
// opened; the browser cannot follow it (no CORS), so this follows its redirects for a signed-in member
// and returns the final address only. Only Google's own short-link hosts are accepted, every hop must
// stay on a Google host (no open proxy), at most 5 hops, 5 seconds each, nothing else is fetched.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders, errorResponse, successResponse } from "../_shared/http.ts";

const SHORT_HOSTS = new Set(["maps.app.goo.gl", "goo.gl"]);
const isGoogleHost = (host: string) =>
  SHORT_HOSTS.has(host) || host === "google.com" || host.endsWith(".google.com") || /^(www\.|maps\.)?google\.[a-z.]{2,6}$/.test(host);

const BROWSER = { "user-agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36", "accept-language": "en" };

function decodeSafe(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

// the place's own position (!3d/!4d) first, then the map's centre, a query, or the page's preview image
function positionIn(text: string): { latitude: number; longitude: number } | null {
  const patterns = [
    /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,
    /[?&](?:q|query|ll|center|destination)=(-?\d+\.\d+)(?:,|%2C)\s*(-?\d+\.\d+)/i,
    /@(-?\d+\.\d+),(-?\d+\.\d+)/,
    /center=(-?\d+\.\d+)%2C(-?\d+\.\d+)/i,
    /\[null,null,(-?\d+\.\d+),(-?\d+\.\d+)\]/,
  ];
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (!m) continue;
    const latitude = Number(m[1]);
    const longitude = Number(m[2]);
    if (Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 && !(latitude === 0 && longitude === 0)) {
      return { latitude, longitude };
    }
  }
  // owner 2026-11-14: the phone page of a place keeps its view as [[height, lng, lat],[0,0,0],...] (longitude first)
  const view = text.match(/\[\[\d+(?:\.\d+)?,(-?\d+\.\d+),(-?\d+\.\d+)\],\[0,0,0\]/);
  if (view) {
    const longitude = Number(view[1]);
    const latitude = Number(view[2]);
    if (Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 && !(latitude === 0 && longitude === 0)) return { latitude, longitude };
  }
  return null;
}

// the computer page carries the map's centre in its preview image (center=lat%2Clng)
const DESKTOP = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", "accept-language": "en", cookie: "CONSENT=YES+1; SOCS=CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg" };

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
    // owner 2026-11-13: a limit on requests - 20 every 10 minutes for each person
    const { data: allowed, error: limitError } = await caller.rpc("prosm_time_take_rate_limit", { p_action: "resolve-map-link", p_max: 20, p_window_seconds: 600 });
    if (limitError || allowed !== true) return errorResponse("Too many requests - try again in a few minutes.", 429, "RATE_LIMITED");

    const body = await request.json().catch(() => ({}));
    const raw = typeof body?.url === "string" ? body.url.trim() : "";
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      return errorResponse("Not a link.", 400, "INVALID_LINK");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return errorResponse("Not a link.", 400, "INVALID_LINK");
    // owner 2026-11-13: Google links only - maps.app.goo.gl, goo.gl/maps and google.com/maps
    const host = url.hostname.toLowerCase();
    const isMapLink = host === "maps.app.goo.gl"
      || (host === "goo.gl" && url.pathname.startsWith("/maps"))
      || ((host === "google.com" || host === "www.google.com" || host === "maps.google.com") && (host === "maps.google.com" || url.pathname.startsWith("/maps")));
    if (!isMapLink) return errorResponse("Only Google Maps links.", 400, "NOT_A_MAP_LINK");

    let current = url;
    for (let hop = 0; hop < 6; hop++) {
      // owner 2026-11-13: Google's cookie-consent page (seen from a European server) carries the real address
      // in its "continue" parameter - follow that instead of the consent page
      if (current.hostname.toLowerCase() === "consent.google.com") {
        const cont = current.searchParams.get("continue");
        if (!cont) break;
        const target = new URL(cont);
        if (!isGoogleHost(target.hostname.toLowerCase())) return errorResponse("The link leaves Google Maps.", 400, "NOT_A_MAP_LINK");
        current = target;
        continue;
      }
      const response = await fetch(current.toString(), { method: "GET", redirect: "manual", headers: BROWSER, signal: AbortSignal.timeout(5000) });
      const next = response.headers.get("location");
      await response.body?.cancel();
      if (!next || response.status < 300 || response.status >= 400) break;
      const target = new URL(next, current);
      if (!isGoogleHost(target.hostname.toLowerCase())) return errorResponse("The link leaves Google Maps.", 400, "NOT_A_MAP_LINK");
      current = target;
    }
    // owner 2026-11-13: today's shared links often end on ".../maps/place/<name>/data=..." with no position in
    // the address - the position is then read from the Google Maps page itself (same Google host, one request)
    let position = positionIn(decodeSafe(current.toString()));
    if (!position && isGoogleHost(current.hostname.toLowerCase())) {
      const page = await fetch(current.toString(), { method: "GET", headers: DESKTOP, signal: AbortSignal.timeout(6000) }).catch(() => null);
      const html = page && page.ok ? (await page.text()).slice(0, 2_000_000) : "";
      // owner 2026-11-14: a page that did not open the place itself (a consent page, or the server's own area seen
      // from abroad) shows a map of somewhere else - its centre is trusted only when the page is about this place
      const placeId = decodeSafe(current.toString()).match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i)?.[1];
      position = !placeId || html.includes(placeId) ? positionIn(html) : null;
    }
    const place = current.pathname.match(/\/maps\/place\/([^/]+)/);
    return successResponse({
      url: current.toString(),
      latitude: position?.latitude ?? null,
      longitude: position?.longitude ?? null,
      placeName: place ? decodeSafe(place[1]).replace(/\+/g, " ").slice(0, 200) : null,
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Could not open the link.", 500, "RESOLVE_FAILED");
  }
});
