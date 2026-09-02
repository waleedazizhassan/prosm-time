// approve-allowance-entry - Allowances feature (2026-09-02 plan).
// Forwards the caller's own session to approve_prosm_time_allowance_
// entry(), which re-checks 'allowances.approve' (site-scoped) or
// Owner server-side. Unified entry point for both approve and reject.
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
    const { entryId, action, notes } = payload;
    if (!entryId || typeof entryId !== "string") return errorResponse("entryId is required.", 400, "INVALID_REQUEST");
    if (!action || typeof action !== "string") return errorResponse("action is required.", 400, "INVALID_REQUEST");

    const { data, error } = await callerClient.rpc("approve_prosm_time_allowance_entry", {
      p_entry_id: entryId,
      p_action: action,
      p_notes: notes ?? null,
    });

    if (error || !data?.success) return errorResponse(error?.message ?? "Unable to review this allowance entry.", 400, "APPROVE_FAILED");
    return successResponse({});
  } catch (error: any) {
    return errorResponse(error?.message ?? "Allowances service unavailable.", 500, "INTERNAL_ERROR");
  }
});
