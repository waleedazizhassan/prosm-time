// review-timesheet-correction - WP-16 (§22, §35). Forwards the
// caller's own session to review_prosm_time_timesheet_correction(),
// which re-checks 'attendance.correct' (or Owner) server-side. An
// approved correction reopens the timesheet to 'draft' for
// resubmission (§22: "Correction requires an explicit correction
// workflow and audit trail").
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
    const { correctionId, action, notes } = payload;
    if (!correctionId || typeof correctionId !== "string") return errorResponse("correctionId is required.", 400, "INVALID_REQUEST");
    if (!action || typeof action !== "string") return errorResponse("action is required.", 400, "INVALID_REQUEST");

    const { data, error } = await callerClient.rpc("review_prosm_time_timesheet_correction", {
      p_correction_id: correctionId,
      p_action: action,
      p_notes: notes ?? null,
    });

    if (error || !data?.success) return errorResponse(error?.message ?? "Unable to review this correction.", 400, "REVIEW_FAILED");
    return successResponse({ correctionId: data.correctionId, status: data.status });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Timesheet service unavailable.", 500, "INTERNAL_ERROR");
  }
});
