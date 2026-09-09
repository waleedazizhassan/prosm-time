// approve-timesheet - WP-16 (§22, §35). Forwards the caller's own
// session to approve_prosm_time_timesheet(), which re-checks
// 'timesheets.approve' (or Owner) server-side. Unified entry point for
// both the approve and reject decision (§22: "manager reviews and
// approves; approved period becomes locked").
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";
import { checkInstallationGate } from "../_shared/installationGate.ts";

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

    const gate = await checkInstallationGate(callerClient, supabaseUrl, anonKey, authorizationHeader);
    if (!gate.allowed) return errorResponse(gate.reason ?? "This installation is not covered by a valid license.", 403, "INSTALLATION_BLOCKED");

    const payload = await request.json().catch(() => ({}));
    const { timesheetId, action, notes } = payload;
    if (!timesheetId || typeof timesheetId !== "string") return errorResponse("timesheetId is required.", 400, "INVALID_REQUEST");
    if (!action || typeof action !== "string") return errorResponse("action is required.", 400, "INVALID_REQUEST");

    const { data, error } = await callerClient.rpc("approve_prosm_time_timesheet", {
      p_timesheet_id: timesheetId,
      p_action: action,
      p_notes: notes ?? null,
    });

    if (error || !data?.success) return errorResponse(error?.message ?? "Unable to review this timesheet.", 400, "APPROVE_FAILED");
    return successResponse({ timesheetId: data.timesheetId, status: data.status });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Timesheet service unavailable.", 500, "INTERNAL_ERROR");
  }
});
