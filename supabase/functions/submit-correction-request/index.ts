// submit-correction-request - WP-11 (§17.3, §35 Edge-Function-mediated
// "correction requests"). Forwards the caller's own session to
// submit_prosm_time_correction_request(), which re-validates the
// session belongs to the caller. Never modifies the original record.
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
    const { attendanceSessionId, proposedEventType, proposedCorrectTime, reason } = payload;
    if (!attendanceSessionId || typeof attendanceSessionId !== "string") return errorResponse("attendanceSessionId is required.", 400, "INVALID_REQUEST");
    if (!proposedEventType || typeof proposedEventType !== "string") return errorResponse("proposedEventType is required.", 400, "INVALID_REQUEST");
    if (!proposedCorrectTime || typeof proposedCorrectTime !== "string") return errorResponse("proposedCorrectTime is required.", 400, "INVALID_REQUEST");
    if (!reason || typeof reason !== "string" || reason.trim().length === 0) return errorResponse("reason is required.", 400, "INVALID_REQUEST");

    const { data, error } = await callerClient.rpc("submit_prosm_time_correction_request", {
      p_attendance_session_id: attendanceSessionId,
      p_proposed_event_type: proposedEventType,
      p_proposed_correct_time: proposedCorrectTime,
      p_reason: reason.trim(),
    });

    if (error || !data?.success) return errorResponse(error?.message ?? "Unable to submit this correction request.", 400, "SUBMIT_FAILED");
    return successResponse({ correctionRequestId: data.correctionRequestId });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Correction request service unavailable.", 500, "INTERNAL_ERROR");
  }
});
