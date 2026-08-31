// review-exception - WP-11 (§19 step 7, §35 Edge-Function-mediated
// "exception actions"). Unified entry point for a manager's decision
// on either a geofence exception or a correction request. Forwards the
// caller's own session to review_prosm_time_exception(), which
// re-checks 'exceptions.manage' (or Owner) server-side.
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
    const { kind, targetId, actionType, notes } = payload;
    if (!kind || typeof kind !== "string") return errorResponse("kind is required.", 400, "INVALID_REQUEST");
    if (!targetId || typeof targetId !== "string") return errorResponse("targetId is required.", 400, "INVALID_REQUEST");
    if (!actionType || typeof actionType !== "string") return errorResponse("actionType is required.", 400, "INVALID_REQUEST");

    const { data, error } = await callerClient.rpc("review_prosm_time_exception", {
      p_kind: kind,
      p_target_id: targetId,
      p_action_type: actionType,
      p_notes: notes ?? null,
    });

    if (error || !data?.success) return errorResponse(error?.message ?? "Unable to review this item.", 400, "REVIEW_FAILED");
    return successResponse({ actionId: data.actionId });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Exception service unavailable.", 500, "INTERNAL_ERROR");
  }
});
