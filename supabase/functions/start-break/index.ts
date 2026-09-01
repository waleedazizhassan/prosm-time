// start-break - WP-12 (§17.1, §35 "break events"). Forwards the
// caller's own session to start_prosm_time_break().
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
    const { attendanceSessionId, idempotencyKey } = payload;
    if (!attendanceSessionId || typeof attendanceSessionId !== "string") return errorResponse("attendanceSessionId is required.", 400, "INVALID_REQUEST");

    const { data, error } = await callerClient.rpc("start_prosm_time_break", {
      p_attendance_session_id: attendanceSessionId,
      p_idempotency_key: idempotencyKey ?? null,
    });

    if (error || !data?.success) return errorResponse(error?.message ?? "Unable to start a break.", 400, "START_BREAK_FAILED");
    return successResponse({ breakId: data.breakId, replay: data.replay });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Break service unavailable.", 500, "INTERNAL_ERROR");
  }
});
