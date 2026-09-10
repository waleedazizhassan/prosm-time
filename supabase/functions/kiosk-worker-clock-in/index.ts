// kiosk-worker-clock-in - external/contractor workforce kiosk
// clock-in. Mirrors kiosk-clock-in's own posture exactly: the caller
// is whoever is signed into the operating kiosk device (establishes
// organization/site context only) - the WORKER's own identity is
// proven by their 6-digit worker number, not the caller's session. No
// photo; a real GPS sample is mandatory (kiosk_worker_clock_in itself
// rejects a null lat/long).
//
// § real gap fix, 14-point live-audit - a 6-digit worker number is
// this endpoint's ONLY credential (no PIN, no photo) - rate-limited
// per (site, number) so it can't be brute-forced across the ~900k
// possible numbers, and per caller IP.
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";
import { clientIdentifier, enforceRateLimits } from "../_shared/rateLimit.ts";

serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return errorResponse("Method not allowed.", 405, "METHOD_NOT_ALLOWED");

  try {
    const authorizationHeader = request.headers.get("authorization");
    if (!authorizationHeader) return errorResponse("Missing Authorization header.", 401, "UNAUTHORIZED");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const callerClient = createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: authorizationHeader } },
    });

    const {
      data: { user: authUser },
    } = await callerClient.auth.getUser();
    if (!authUser) return errorResponse("Invalid or expired session.", 401, "UNAUTHORIZED");

    const payload = await request.json().catch(() => ({}));
    const { siteId, workerNumber, latitude, longitude } = payload;

    if (!siteId || typeof siteId !== "string") return errorResponse("siteId is required.", 400, "INVALID_REQUEST");
    if (!workerNumber || typeof workerNumber !== "string") return errorResponse("workerNumber is required.", 400, "INVALID_REQUEST");
    if (typeof latitude !== "number" || typeof longitude !== "number") return errorResponse("A real GPS sample is required.", 400, "INVALID_REQUEST");

    const serviceClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const rateLimited = await enforceRateLimits(serviceClient, [
      { scope: "kiosk_worker_clock_in_number", identifier: `${siteId}:${workerNumber}`, limit: 10, windowSeconds: 900, blockSeconds: 1800 },
      { scope: "kiosk_worker_clock_in_ip", identifier: clientIdentifier(request), limit: 60, windowSeconds: 900, blockSeconds: 900 },
    ]);
    if (rateLimited) return rateLimited;

    const { data, error } = await callerClient.rpc("kiosk_worker_clock_in", {
      p_site_id: siteId,
      p_worker_number: workerNumber,
      p_latitude: latitude,
      p_longitude: longitude,
    });

    if (error || !data?.success) return errorResponse(error?.message ?? "Unable to clock in.", 400, "KIOSK_WORKER_CLOCK_IN_FAILED");
    return successResponse({ entryId: data.entryId, workerName: data.workerName });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Kiosk service unavailable.", 500, "INTERNAL_ERROR");
  }
});
