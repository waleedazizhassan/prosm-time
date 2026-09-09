// sync-installation-identity - PROSM Time's minimal integration-contract
// addition for the Anti-Crack & Unauthorized Installation spec
// (user-directed, centralized in Platform Management). Called by an
// already-authenticated organization member (verify_jwt = true, default,
// same posture as refresh-license-status), on first use registers this
// organization's installation with Platform Management (or reuses an
// existing registration), then validates it and caches the result
// locally. Deliberately does NOT gate any protected operation itself -
// that is a separate, later step per the user's own instruction.
// deno-lint-ignore-file no-explicit-any

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";

const APP_VERSION = "2.3.0";

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

    const payload = await request.json().catch(() => ({}));
    const platform: string = ["web", "android", "windows"].includes(payload?.platform) ? payload.platform : "web";

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const managementApiUrl = Deno.env.get("PROSM_MANAGEMENT_API_URL");
    const managementApiKey = Deno.env.get("PROSM_MANAGEMENT_API_KEY");
    if (!managementApiUrl || !managementApiKey) {
      return errorResponse("Integration contract is not configured.", 500, "INTEGRATION_NOT_CONFIGURED");
    }

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

    // license_activation_state is org-scoped and RLS'd - the caller's
    // own session can read it directly (established pattern already
    // used by refresh-license-status).
    const { data: licenseRow } = await callerClient.from("license_activation_state").select("license_number").maybeSingle();

    const { data: credRows } = await serviceClient.rpc("get_prosm_time_installation_credentials", { p_organization_id: callerRow.organization_id });
    let credentials = credRows?.[0] as { installation_key: string; installation_secret: string } | undefined;

    if (!credentials) {
      const registerResponse = await fetch(managementApiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-prosm-api-key": managementApiKey },
        body: JSON.stringify({
          action: "registerInstallation",
          organizationId: callerRow.organization_id,
          externalUserId: callerRow.id,
          platform,
          appVersion: APP_VERSION,
          licenseNumber: licenseRow?.license_number ?? null,
        }),
      });
      const registerResult = await registerResponse.json().catch(() => null);
      if (!registerResponse.ok || !registerResult?.success) {
        return errorResponse(registerResult?.error?.message ?? "Unable to register this installation.", 400, registerResult?.error?.code ?? "REGISTRATION_FAILED");
      }

      await serviceClient.rpc("upsert_prosm_time_installation_identity", {
        p_organization_id: callerRow.organization_id,
        p_installation_key: registerResult.data.installationKey,
        p_installation_secret: registerResult.data.installationSecret,
        p_platform: platform,
        p_app_version: APP_VERSION,
      });
      credentials = { installation_key: registerResult.data.installationKey, installation_secret: registerResult.data.installationSecret };
    }

    const validateResponse = await fetch(managementApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-prosm-api-key": managementApiKey },
      body: JSON.stringify({
        action: "validateInstallation",
        installationKey: credentials.installation_key,
        installationSecret: credentials.installation_secret,
        appVersion: APP_VERSION,
      }),
    });
    const validateResult = await validateResponse.json().catch(() => null);
    if (!validateResponse.ok || !validateResult?.success) {
      return errorResponse(validateResult?.error?.message ?? "Unable to validate this installation.", 400, validateResult?.error?.code ?? "VALIDATION_FAILED");
    }

    await serviceClient.rpc("record_prosm_time_installation_evaluation", {
      p_organization_id: callerRow.organization_id,
      p_state: validateResult.data.state,
      p_grace_ends_at: validateResult.data.graceEndsAt,
      p_message: validateResult.data.message,
      p_outdated_version: validateResult.data.outdatedVersion ?? false,
    });

    return successResponse({ state: validateResult.data.state, graceEndsAt: validateResult.data.graceEndsAt, message: validateResult.data.message });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Installation identity service unavailable.", 500, "INTERNAL_ERROR");
  }
});
