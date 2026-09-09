// export-employee-data - WP-22 (§24, §35). "Admin can export... an
// individual employee's personal attendance data on request." Forwards
// the caller's own session to export_prosm_time_employee_data(), which
// re-checks 'employees.manage_accounts' (or Owner) server-side.
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
    const { userId } = payload;
    if (!userId || typeof userId !== "string") return errorResponse("userId is required.", 400, "INVALID_REQUEST");

    const { data, error } = await callerClient.rpc("export_prosm_time_employee_data", { p_user_id: userId });

    if (error || !data?.success) return errorResponse(error?.message ?? "Unable to export this employee's data.", 400, "EXPORT_FAILED");
    return successResponse(data);
  } catch (error: any) {
    return errorResponse(error?.message ?? "Data export service unavailable.", 500, "INTERNAL_ERROR");
  }
});
