// activate-organization - PROSM Time Implementation Master File V3.0,
// WP-03 (§5/§6/§38: "Activation (consuming WP-00's API), organization
// setup, administrator onboarding"). The one entry point a brand-new
// customer reaches with no session at all - deliberately verify_jwt =
// false (see supabase/config.toml), same posture as PROSM Platform's
// own initialize-prosm.
//
// Real cross-system flow, in order:
//   1. Call PROSM Management's integration contract (§6/§35 - its own
//      versioned API, authenticated by PROSM_MANAGEMENT_API_KEY, never
//      a shared table/auth secret) to redeem the activation code
//      server-side. §5: "Activation must be verified server-side
//      against PROSM Management's API; never trust a client-only
//      activation flag."
//   2. Only on a REAL success from that call: create the Owner's
//      Supabase Auth account (service role, mirrors PROSM Platform's
//      own establish-organization-owner pattern exactly - random
//      caller-supplied password, email_confirm true so no separate
//      verification email blocks first login).
//   3. Call bootstrap_prosm_time_organization() (service_role-only RPC)
//      to create the organization/settings/license-state/Owner-user
//      atomically in one Postgres transaction.
//   4. If step 3 fails, roll back the just-created Auth account (same
//      "never leave a dangling account" posture as
//      establish-organization-owner) - the activation code is already
//      consumed on PROSM Management's side at that point (a known,
//      documented cross-system edge case: there is no "un-consume" RPC,
//      matching how a revoked-but-consumed code is handled on that side
//      too), surfaced as a clear error asking the customer to contact
//      support with their license number rather than silently retrying.
// deno-lint-ignore-file no-explicit-any

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";

interface ActivationResult {
  success: boolean;
  data?: {
    licenseNumber: string;
    planId: string | null;
    maxUsers: number | null;
    maxDevices: number | null;
    expiresAt: string | null;
    status: string;
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
    const payload = await request.json().catch(() => ({}));
    const { activationCode, organizationName, ownerEmail, ownerPassword, ownerFullName, siteName } = payload;

    if (!activationCode || typeof activationCode !== "string") {
      return errorResponse("activationCode is required.", 400, "INVALID_REQUEST");
    }
    if (!organizationName || typeof organizationName !== "string" || organizationName.trim().length === 0) {
      return errorResponse("organizationName is required.", 400, "INVALID_REQUEST");
    }
    if (!ownerEmail || typeof ownerEmail !== "string" || !ownerEmail.includes("@")) {
      return errorResponse("A valid ownerEmail is required.", 400, "INVALID_REQUEST");
    }
    if (!ownerPassword || typeof ownerPassword !== "string" || ownerPassword.length < 8) {
      return errorResponse("ownerPassword must be at least 8 characters.", 400, "INVALID_REQUEST");
    }
    if (!ownerFullName || typeof ownerFullName !== "string" || ownerFullName.trim().length === 0) {
      return errorResponse("ownerFullName is required.", 400, "INVALID_REQUEST");
    }
    // § live UX review, user-directed - "a field to type your site
    // name during activation, so reports never show a blank site."
    // Required, same posture as organizationName - a brand-new org
    // should never reach the dashboard with zero sites.
    if (!siteName || typeof siteName !== "string" || siteName.trim().length === 0) {
      return errorResponse("siteName is required.", 400, "INVALID_REQUEST");
    }

    const managementApiUrl = Deno.env.get("PROSM_MANAGEMENT_API_URL");
    const managementApiKey = Deno.env.get("PROSM_MANAGEMENT_API_KEY");
    if (!managementApiUrl || !managementApiKey) {
      return errorResponse("Integration contract is not configured.", 500, "INTEGRATION_NOT_CONFIGURED");
    }

    // Step 1 - redeem the activation code against PROSM Management. This
    // is the ONLY network boundary crossed in this function - everything
    // after this point is PROSM Time's own database.
    const activationResponse = await fetch(managementApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-prosm-api-key": managementApiKey },
      body: JSON.stringify({
        action: "activate",
        code: activationCode.trim(),
        customerName: organizationName.trim(),
        customerReference: ownerEmail.trim().toLowerCase(),
      }),
    });

    const activationResult = (await activationResponse.json().catch(() => null)) as ActivationResult | null;

    if (!activationResponse.ok || !activationResult?.success || !activationResult.data) {
      return errorResponse(
        activationResult?.error?.message ?? "Unable to verify this activation code.",
        400,
        activationResult?.error?.code ?? "ACTIVATION_VERIFICATION_FAILED"
      );
    }

    const license = activationResult.data;

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Step 2 - real Supabase Auth account for the Owner.
    const { data: authResult, error: authError } = await serviceClient.auth.admin.createUser({
      email: ownerEmail.trim().toLowerCase(),
      password: ownerPassword,
      email_confirm: true,
    });
    if (authError || !authResult?.user) {
      return errorResponse(authError?.message ?? "Unable to create the Owner's account.", 500, "AUTH_ACCOUNT_CREATE_FAILED");
    }
    const authUserId = authResult.user.id;

    // Step 3 - atomic organization/settings/license/Owner bootstrap.
    const { data: bootstrapResult, error: bootstrapError } = await serviceClient.rpc("bootstrap_prosm_time_organization", {
      p_organization_name: organizationName.trim(),
      p_auth_user_id: authUserId,
      p_owner_email: ownerEmail.trim().toLowerCase(),
      p_owner_full_name: ownerFullName.trim(),
      p_license_number: license.licenseNumber,
      p_plan_id: license.planId,
      p_max_users: license.maxUsers,
      p_max_devices: license.maxDevices,
      p_expires_at: license.expiresAt,
      p_site_name: siteName.trim(),
    });

    if (bootstrapError || !bootstrapResult?.success) {
      try {
        await serviceClient.auth.admin.deleteUser(authUserId);
      } catch (rollbackError) {
        console.error("[activate-organization] ROLLBACK AUTH USER failed", rollbackError);
      }
      return errorResponse(
        `Activation succeeded on PROSM Management (license ${license.licenseNumber}) but organization setup failed: ${
          bootstrapError?.message ?? "unknown error"
        }. Contact support with this license number - the activation code cannot be reused.`,
        500,
        "ORGANIZATION_BOOTSTRAP_FAILED"
      );
    }

    return successResponse({
      organizationId: bootstrapResult.organizationId,
      userId: bootstrapResult.userId,
      licenseNumber: license.licenseNumber,
    });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Activation service unavailable.", 500, "INTERNAL_ERROR");
  }
});
