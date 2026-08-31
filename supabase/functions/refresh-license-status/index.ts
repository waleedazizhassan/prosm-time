// refresh-license-status - PROSM Time Implementation Master File V3.0,
// WP-03 (§5: "License renewal, suspension, expiration and revocation
// are lifecycle states, initiated from PROSM Management and reflected
// in the standalone app via the integration contract"). Called by an
// already-authenticated organization member (verify_jwt = true,
// default) to re-pull the latest status from PROSM Management and
// refresh the local, never-authoritative cache (§34).
// deno-lint-ignore-file no-explicit-any

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";

interface LicenseStatusResult {
  success: boolean;
  data?: {
    status: string;
    maxUsers: number | null;
    maxDevices: number | null;
    expiresAt: string | null;
  };
  error?: { message: string; code?: string };
}

serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return errorResponse("Method not allowed.", 405, "METHOD_NOT_ALLOWED");
  }

  try {
    const authorizationHeader = request.headers.get("authorization");
    if (!authorizationHeader) {
      return errorResponse("Missing Authorization header.", 401, "UNAUTHORIZED");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const callerClient = createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: authorizationHeader } },
    });
    const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const {
      data: { user: authUser },
    } = await callerClient.auth.getUser();
    if (!authUser) {
      return errorResponse("Invalid or expired session.", 401, "UNAUTHORIZED");
    }

    const { data: callerRow } = await callerClient
      .from("users")
      .select("id, organization_id")
      .eq("auth_user_id", authUser.id)
      .maybeSingle();
    if (!callerRow) {
      return errorResponse("Caller not found.", 401, "UNAUTHORIZED");
    }

    const { data: licenseRow } = await callerClient
      .from("license_activation_state")
      .select("license_number")
      .eq("organization_id", callerRow.organization_id)
      .maybeSingle();
    if (!licenseRow) {
      return errorResponse("No license activation state found for this organization.", 404, "LICENSE_STATE_NOT_FOUND");
    }

    const managementApiUrl = Deno.env.get("PROSM_MANAGEMENT_API_URL");
    const managementApiKey = Deno.env.get("PROSM_MANAGEMENT_API_KEY");
    if (!managementApiUrl || !managementApiKey) {
      return errorResponse("Integration contract is not configured.", 500, "INTEGRATION_NOT_CONFIGURED");
    }

    const statusResponse = await fetch(managementApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-prosm-api-key": managementApiKey },
      body: JSON.stringify({ action: "licenseStatus", licenseNumber: licenseRow.license_number }),
    });

    const statusResult = (await statusResponse.json().catch(() => null)) as LicenseStatusResult | null;

    if (!statusResponse.ok || !statusResult?.success || !statusResult.data) {
      return errorResponse(
        statusResult?.error?.message ?? "Unable to verify license status with PROSM Management.",
        400,
        statusResult?.error?.code ?? "LICENSE_STATUS_CHECK_FAILED"
      );
    }

    const { data: refreshResult, error: refreshError } = await serviceClient.rpc("refresh_prosm_time_license_state", {
      p_organization_id: callerRow.organization_id,
      p_status: statusResult.data.status,
      p_max_users: statusResult.data.maxUsers,
      p_max_devices: statusResult.data.maxDevices,
      p_expires_at: statusResult.data.expiresAt,
    });

    if (refreshError || !refreshResult?.success) {
      return errorResponse(refreshError?.message ?? "Unable to refresh the local license cache.", 500, "LICENSE_STATE_REFRESH_FAILED");
    }

    return successResponse({ status: statusResult.data.status, expiresAt: statusResult.data.expiresAt });
  } catch (error: any) {
    return errorResponse(error?.message ?? "License status service unavailable.", 500, "INTERNAL_ERROR");
  }
});
