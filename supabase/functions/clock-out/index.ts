// clock-out - PROSM Time Implementation Master File V3.0, WP-06 (§17,
// §35). Mirrors clock-in exactly: forwards the caller's own session to
// clock_out_prosm_time_attendance(), which finds their currently-open
// session, validates idempotent replay, and closes it server-side.
// deno-lint-ignore-file no-explicit-any

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";

serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return errorResponse("Method not allowed.", 405, "METHOD_NOT_ALLOWED");
  }

  try {
    const authorizationHeader = request.headers.get("authorization");
    if (!authorizationHeader) {
      return errorResponse("Missing Authorization header.", 401, "UNAUTHORIZED");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const callerClient = createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: authorizationHeader } },
    });

    const {
      data: { user: authUser },
    } = await callerClient.auth.getUser();
    if (!authUser) {
      return errorResponse("Invalid or expired session.", 401, "UNAUTHORIZED");
    }

    const payload = await request.json().catch(() => ({}));
    const { idempotencyKey, clientReportedAt, latitude, longitude, accuracyMeters } = payload;

    if (!idempotencyKey || typeof idempotencyKey !== "string") {
      return errorResponse("idempotencyKey is required.", 400, "INVALID_REQUEST");
    }

    const { data, error } = await callerClient.rpc("clock_out_prosm_time_attendance", {
      p_idempotency_key: idempotencyKey,
      p_client_reported_at: clientReportedAt ?? null,
      p_latitude: typeof latitude === "number" ? latitude : null,
      p_longitude: typeof longitude === "number" ? longitude : null,
      p_accuracy_meters: typeof accuracyMeters === "number" ? accuracyMeters : null,
    });

    if (error || !data?.success) {
      return errorResponse(error?.message ?? "Unable to clock out.", 400, "CLOCK_OUT_FAILED");
    }

    return successResponse({ sessionId: data.sessionId, eventId: data.eventId, replay: data.replay });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Attendance service unavailable.", 500, "INTERNAL_ERROR");
  }
});
