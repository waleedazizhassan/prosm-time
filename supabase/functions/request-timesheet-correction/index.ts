// request-timesheet-correction - WP-16 (§22, §35). Forwards the
// caller's own session to request_prosm_time_timesheet_correction(),
// which re-checks the caller is the timesheet's own subject and it is
// currently locked (status 'approved').
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
    const { timesheetId, reason } = payload;
    if (!timesheetId || typeof timesheetId !== "string") return errorResponse("timesheetId is required.", 400, "INVALID_REQUEST");
    if (!reason || typeof reason !== "string") return errorResponse("reason is required.", 400, "INVALID_REQUEST");

    const { data, error } = await callerClient.rpc("request_prosm_time_timesheet_correction", {
      p_timesheet_id: timesheetId,
      p_reason: reason,
    });

    if (error || !data?.success) return errorResponse(error?.message ?? "Unable to request this correction.", 400, "REQUEST_FAILED");
    return successResponse({ correctionId: data.correctionId });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Timesheet service unavailable.", 500, "INTERNAL_ERROR");
  }
});
