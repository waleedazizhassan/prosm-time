// admin-clock-out - PROSM Time Implementation Master File V3.0, WP-07
// (§10). Mirrors admin-clock-in exactly: forwards the caller's own
// session to admin_clock_out_prosm_time_attendance(), which re-checks
// 'attendance.clock_out_on_behalf' (or Owner) server-side, requires a
// reason, and closes the subject's currently-open session with the
// caller recorded as the real ACTOR.
// deno-lint-ignore-file no-explicit-any

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";
import { checkInstallationGate } from "../_shared/installationGate.ts";

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

    const gate = await checkInstallationGate(callerClient, supabaseUrl, anonKey, authorizationHeader);
    if (!gate.allowed) {
      return errorResponse(gate.reason ?? "This installation is not covered by a valid license.", 403, "INSTALLATION_BLOCKED");
    }

    const payload = await request.json().catch(() => ({}));
    const { subjectUserId, reason, idempotencyKey, latitude, longitude, accuracyMeters } = payload;

    if (!subjectUserId || typeof subjectUserId !== "string") {
      return errorResponse("subjectUserId is required.", 400, "INVALID_REQUEST");
    }
    if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
      return errorResponse("reason is required.", 400, "INVALID_REQUEST");
    }

    const deviceInfo = request.headers.get("user-agent");

    const { data, error } = await callerClient.rpc("admin_clock_out_prosm_time_attendance", {
      p_subject_user_id: subjectUserId,
      p_reason: reason.trim(),
      p_idempotency_key: idempotencyKey ?? null,
      p_latitude: typeof latitude === "number" ? latitude : null,
      p_longitude: typeof longitude === "number" ? longitude : null,
      p_accuracy_meters: typeof accuracyMeters === "number" ? accuracyMeters : null,
      p_device_info: deviceInfo,
    });

    if (error || !data?.success) {
      return errorResponse(error?.message ?? "Unable to clock out this employee.", 400, "ADMIN_CLOCK_OUT_FAILED");
    }

    return successResponse({ sessionId: data.sessionId, eventId: data.eventId, actionId: data.actionId, replay: data.replay });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Attendance service unavailable.", 500, "INTERNAL_ERROR");
  }
});
