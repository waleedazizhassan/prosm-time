// remove-employee - live UX review, user-directed correction: "I asked
// for a button to remove an employee from the application - only
// deactivation got built." Two-step, mirrors delete-employee-data
// exactly: (1) the caller's own forwarded session calls
// authorize_prosm_time_employee_removal(), which re-checks Owner
// authority AND the retention/open-session/review-history holds
// server-side and returns the camera-evidence storage paths to remove;
// only once that returns authorized=true does this function escalate
// to the service role (never trusting the client for that decision) to
// remove the storage objects, delete the users row (and everything
// that cascades from it) via remove_prosm_time_employee() (service_
// role-only), and finally delete the real Supabase Auth account too
// (auth.admin.deleteUser - only the service role can do that, which is
// why removal genuinely needs its own account-deletion step deactivate
// never needed).
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";

const BUCKET = "camera-evidence";

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
    const { userId, reason } = payload;
    if (!userId || typeof userId !== "string") return errorResponse("userId is required.", 400, "INVALID_REQUEST");
    if (!reason || typeof reason !== "string") return errorResponse("reason is required.", 400, "INVALID_REQUEST");

    const { data: authData, error: authError } = await callerClient.rpc("authorize_prosm_time_employee_removal", { p_user_id: userId });
    if (authError || !authData?.success) {
      return errorResponse(authError?.message ?? "Unable to authorize this removal.", 400, "AUTHORIZE_FAILED");
    }
    if (!authData.authorized) {
      return errorResponse(authData.reason ?? "This removal is not permitted.", 403, "RETENTION_HOLD");
    }

    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const evidence = (authData.evidence ?? []) as { id: string; storagePath: string }[];
    for (const item of evidence) {
      await serviceClient.storage.from(BUCKET).remove([item.storagePath]);
    }

    const { data: removeData, error: removeError } = await serviceClient.rpc("remove_prosm_time_employee", {
      p_user_id: userId,
      p_actor_user_id: authData.callerUserId,
      p_reason: reason,
    });

    if (removeError || !removeData?.success) {
      return errorResponse(removeError?.message ?? "Unable to remove this employee.", 400, "REMOVE_FAILED");
    }

    if (removeData.authUserId) {
      const { error: deleteAuthError } = await serviceClient.auth.admin.deleteUser(removeData.authUserId);
      if (deleteAuthError) {
        // The employee's application data is already gone at this
        // point - a failed Auth account deletion is a real, visible,
        // retriable ops issue (they can no longer sign in productively
        // since their users row is gone, but the dangling Auth account
        // itself needs manual cleanup), not a reason to pretend removal
        // didn't happen.
        return errorResponse(
          `Employee removed but their sign-in account could not be deleted: ${deleteAuthError.message}. Contact support.`,
          500,
          "AUTH_DELETE_FAILED"
        );
      }
    }

    return successResponse({ removed: true });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Employee removal service unavailable.", 500, "INTERNAL_ERROR");
  }
});
