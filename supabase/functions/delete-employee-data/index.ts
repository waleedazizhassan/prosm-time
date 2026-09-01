// delete-employee-data - WP-22 (§24, §35). "Admin can... delete an
// individual employee's personal attendance data on request, subject
// to legal/retention holds." Two-step: (1) the caller's own forwarded
// session calls authorize_prosm_time_employee_data_deletion(), which
// re-checks 'employees.manage_accounts' (or Owner) AND the retention
// holds server-side and returns the camera-evidence storage paths to
// remove; only once that returns authorized=true does this function
// escalate to the service role (never trusting the client for that
// decision) to remove the storage objects and perform the actual
// deletion via delete_prosm_time_employee_data() (service_role-only,
// mirrors the WP-08 purge-camera-evidence pattern exactly).
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

    const { data: authData, error: authError } = await callerClient.rpc("authorize_prosm_time_employee_data_deletion", { p_user_id: userId });
    if (authError || !authData?.success) {
      return errorResponse(authError?.message ?? "Unable to authorize this deletion.", 400, "AUTHORIZE_FAILED");
    }
    if (!authData.authorized) {
      return errorResponse(authData.reason ?? "This deletion is not permitted.", 403, "RETENTION_HOLD");
    }

    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const evidence = (authData.evidence ?? []) as { id: string; storagePath: string }[];
    const storageFailures: { id: string; message: string }[] = [];
    for (const item of evidence) {
      const { error: storageError } = await serviceClient.storage.from(BUCKET).remove([item.storagePath]);
      if (storageError) storageFailures.push({ id: item.id, message: storageError.message });
    }

    const { data: deleteData, error: deleteError } = await serviceClient.rpc("delete_prosm_time_employee_data", {
      p_user_id: userId,
      p_actor_user_id: authData.callerUserId,
      p_reason: reason,
    });

    if (deleteError || !deleteData?.success) {
      return errorResponse(deleteError?.message ?? "Unable to delete this employee's data.", 400, "DELETE_FAILED");
    }

    return successResponse({ evidenceRemoved: evidence.length - storageFailures.length, storageFailures });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Data deletion service unavailable.", 500, "INTERNAL_ERROR");
  }
});
