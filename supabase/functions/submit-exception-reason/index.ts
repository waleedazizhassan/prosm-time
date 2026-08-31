// submit-exception-reason - WP-11 (§19 steps 3-5, §35 Edge-Function-
// mediated "exception actions"). Forwards the caller's own session to
// submit_prosm_time_exception_reason(), which re-validates the caller
// owns the exception and it is still pending a reason.
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
    const { exceptionId, reasonCategory, reason } = payload;
    if (!exceptionId || typeof exceptionId !== "string") return errorResponse("exceptionId is required.", 400, "INVALID_REQUEST");
    if (!reasonCategory || typeof reasonCategory !== "string") return errorResponse("reasonCategory is required.", 400, "INVALID_REQUEST");
    if (!reason || typeof reason !== "string" || reason.trim().length === 0) return errorResponse("reason is required.", 400, "INVALID_REQUEST");

    const { data, error } = await callerClient.rpc("submit_prosm_time_exception_reason", {
      p_exception_id: exceptionId,
      p_reason_category: reasonCategory,
      p_reason: reason.trim(),
    });

    if (error || !data?.success) return errorResponse(error?.message ?? "Unable to submit this reason.", 400, "SUBMIT_FAILED");
    return successResponse({});
  } catch (error: any) {
    return errorResponse(error?.message ?? "Exception service unavailable.", 500, "INTERNAL_ERROR");
  }
});
