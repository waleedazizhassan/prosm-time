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

    // Read with the server's rights once the session is verified: a locked trial organisation
    // must still be able to refresh (a renewal in Platform Manager reopens it) or be activated.
    const { data: callerRow } = await serviceClient
      .from("users")
      .select("id, organization_id, is_owner, email")
      .eq("auth_user_id", authUser.id)
      .maybeSingle();
    if (!callerRow) {
      return errorResponse("Caller not found.", 401, "UNAUTHORIZED");
    }

    const { data: licenseRow } = await serviceClient
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

    // A purchased activation code (owner 2026-09-29): redeemed with PROSM Platform exactly like at
    // activation, then the organisation moves onto that license - same organisation, same data.
    const payload = await request.json().catch(() => ({}));
    if (typeof payload.activationCode === "string" && payload.activationCode.trim()) {
      if (!callerRow.is_owner) return errorResponse("ONLY THE OWNER CAN ENTER AN ACTIVATION CODE", 403, "OWNER_ONLY");
      const { data: org } = await serviceClient.from("organizations").select("name").eq("id", callerRow.organization_id).maybeSingle();
      const activationResponse = await fetch(managementApiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-prosm-api-key": managementApiKey },
        body: JSON.stringify({ action: "activate", code: payload.activationCode.trim(), customerName: org?.name ?? "", customerReference: String(callerRow.email ?? "").toLowerCase() }),
      });
      const activation = (await activationResponse.json().catch(() => null)) as any;
      if (!activationResponse.ok || !activation?.success || !activation.data) {
        return errorResponse(activation?.error?.message ?? "Unable to verify this activation code.", 400, activation?.error?.code ?? "ACTIVATION_VERIFICATION_FAILED");
      }
      const { error: applyError } = await serviceClient.rpc("apply_prosm_time_license", {
        p_organization_id: callerRow.organization_id,
        p_license_number: activation.data.licenseNumber,
        p_plan_id: activation.data.planId,
        p_max_users: activation.data.maxUsers,
        p_max_devices: activation.data.maxDevices,
        p_expires_at: activation.data.expiresAt,
        p_actor_user_id: callerRow.id,
      });
      if (applyError) {
        return errorResponse(`The code was accepted by PROSM Platform (license ${activation.data.licenseNumber}) but could not be applied: ${applyError.message}. Contact support with this license number.`, 500, "LICENSE_APPLY_FAILED");
      }
      return successResponse({ status: "ACTIVE", expiresAt: activation.data.expiresAt, licenseNumber: activation.data.licenseNumber, activated: true });
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
