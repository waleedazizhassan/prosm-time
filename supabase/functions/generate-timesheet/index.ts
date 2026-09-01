// generate-timesheet - WP-16 (§22, §35 sensitive orchestration).
// Forwards the caller's own session to generate_prosm_time_timesheet(),
// which re-checks 'timesheets.generate' (or Owner) server-side.
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
    const { userId, periodStart, periodEnd } = payload;
    if (!userId || typeof userId !== "string") return errorResponse("userId is required.", 400, "INVALID_REQUEST");
    if (!periodStart || typeof periodStart !== "string") return errorResponse("periodStart is required.", 400, "INVALID_REQUEST");
    if (!periodEnd || typeof periodEnd !== "string") return errorResponse("periodEnd is required.", 400, "INVALID_REQUEST");

    const { data, error } = await callerClient.rpc("generate_prosm_time_timesheet", {
      p_user_id: userId,
      p_period_start: periodStart,
      p_period_end: periodEnd,
    });

    if (error || !data?.success) return errorResponse(error?.message ?? "Unable to generate this timesheet.", 400, "GENERATE_FAILED");
    return successResponse({ timesheetId: data.timesheetId });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Timesheet service unavailable.", 500, "INTERNAL_ERROR");
  }
});
