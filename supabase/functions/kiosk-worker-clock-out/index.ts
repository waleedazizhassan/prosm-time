// kiosk-worker-clock-out - mirrors kiosk-worker-clock-in.
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";

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

    const { data, error } = await callerClient.rpc("kiosk_worker_clock_out", {
      p_site_id: siteId,
      p_worker_number: workerNumber,
      p_latitude: latitude,
      p_longitude: longitude,
    });

    if (error || !data?.success) return errorResponse(error?.message ?? "Unable to clock out.", 400, "KIOSK_WORKER_CLOCK_OUT_FAILED");
    return successResponse({ entryId: data.entryId, workerName: data.workerName });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Kiosk service unavailable.", 500, "INTERNAL_ERROR");
  }
});
