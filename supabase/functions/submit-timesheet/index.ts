// submit-timesheet - WP-16 (§22, §35). Forwards the caller's own
// session to submit_prosm_time_timesheet(), which re-checks the
// caller is the timesheet's own subject and it is in 'draft' status.
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";
import { enforceLicenseGate } from "../_shared/licenseGate.ts";

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

    // Server-side license gate. The client cannot influence this decision.
    const licenseDenial = await enforceLicenseGate(request, "submit-timesheet", authUser.id);
    if (licenseDenial) return licenseDenial;

    const payload = await request.json().catch(() => ({}));
    const { timesheetId } = payload;
    if (!timesheetId || typeof timesheetId !== "string") return errorResponse("timesheetId is required.", 400, "INVALID_REQUEST");

    const { data, error } = await callerClient.rpc("submit_prosm_time_timesheet", { p_timesheet_id: timesheetId });

    if (error || !data?.success) return errorResponse(error?.message ?? "Unable to submit this timesheet.", 400, "SUBMIT_FAILED");
    return successResponse({ timesheetId: data.timesheetId });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Timesheet service unavailable.", 500, "INTERNAL_ERROR");
  }
});
