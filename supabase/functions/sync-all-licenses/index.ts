// sync-all-licenses - owner 2026-11-03: a change in Platform Manager (users, devices, plan,
// end date, suspend/revoke) must reach every organisation for real, not wait for someone
// to open the app. pg_cron calls this every 10 minutes with the service role key; for each
// organisation it asks PROSM Platform for its licence and mirrors it into
// license_activation_state, where the user and device limits are enforced. A change there
// notifies the owners (trigger in 20261103110000). verify_jwt=false like send-push: the
// service-role-only RPCs below are the real authorization check.
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
    const suppliedKey = authorizationHeader.replace(/^Bearer\s+/i, "");
    const client = createClient(supabaseUrl, suppliedKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: authorizationHeader } },
    });

    const { data: licences, error } = await client.rpc("list_prosm_time_licences_for_sync");
    if (error) return errorResponse(error.message, 403, "FORBIDDEN");

    const managementApiUrl = Deno.env.get("PROSM_MANAGEMENT_API_URL");
    const managementApiKey = Deno.env.get("PROSM_MANAGEMENT_API_KEY");
    if (!managementApiUrl || !managementApiKey) return errorResponse("Integration contract is not configured.", 500, "INTEGRATION_NOT_CONFIGURED");

    let synced = 0;
    const failures: { organizationId: string; message: string }[] = [];
    for (const licence of (licences ?? []) as { organization_id: string; license_number: string }[]) {
      try {
        const response = await fetch(managementApiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-prosm-api-key": managementApiKey },
          body: JSON.stringify({ action: "licenseStatus", licenseNumber: licence.license_number }),
        });
        const result = (await response.json().catch(() => null)) as any;
        if (!response.ok || !result?.success || !result.data) {
          failures.push({ organizationId: licence.organization_id, message: result?.error?.message ?? `status ${response.status}` });
          continue;
        }
        const { error: refreshError } = await client.rpc("refresh_prosm_time_license_state", {
          p_organization_id: licence.organization_id,
          p_status: result.data.status,
          p_max_users: result.data.maxUsers,
          p_max_devices: result.data.maxDevices,
          p_expires_at: result.data.expiresAt,
          p_plan_id: result.data.planId ?? null,
          // 2026-11-10: the real number of external workers the licence allows (empty = no limit)
          p_max_external_workers: result.data.maxExternalWorkers ?? null,
        });
        if (refreshError) failures.push({ organizationId: licence.organization_id, message: refreshError.message });
        else synced += 1;
      } catch (error: any) {
        failures.push({ organizationId: licence.organization_id, message: error?.message ?? "failed" });
      }
    }
    return successResponse({ synced, failures });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Licence sync unavailable.", 500, "INTERNAL_ERROR");
  }
});
