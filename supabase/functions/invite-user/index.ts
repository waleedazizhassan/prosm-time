// invite-user - PROSM Time Implementation Master File V3.0, WP-04
// (§12: "Employees receive invitations or controlled onboarding rather
// than administrators handling employee passwords"). Mirrors PROSM
// Platform's own establish-organization-owner "create a real person
// inline" pattern: a real Supabase Auth account with a random password
// nobody ever sees, created here (service role), then linked via
// create_invited_prosm_time_user() - rolled back if that fails, exactly
// like every other multi-step bootstrap in this codebase.
//
// Authorization is real, not just "any logged-in user": the caller's
// own effective permissions (get_prosm_time_effective_permissions) are
// checked for 'employees.create' before anything is created - the RPC
// itself has no idea who is calling, this Edge Function is what makes
// that safe.
//
// Real email delivery is attempted after the invitation is created -
// sendEmail() is a soft dependency (§ _shared/emailService.ts), so a
// relay failure never blocks the invitation itself. Email is relayed
// through PROSM Platform's own prosm-management-integration contract
// (action: "sendEmail"), the same authenticated channel already used
// for activation/license status - PROSM Time never holds Zoho
// credentials at all; Platform remains the sole owner of the ZOHO_*
// secrets and sends from noreply@prosm.net. The verification code is
// always returned in this response too, for the inviting admin to
// share directly - same "controlled one-time display" posture as
// every other secret in this codebase, now a real delivered email as
// well as a fallback the admin can act on immediately.
// deno-lint-ignore-file no-explicit-any

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";
import { checkInstallationGate } from "../_shared/installationGate.ts";
import { sendEmail } from "../_shared/emailService.ts";
import { renderInvitationEmail } from "../_shared/emailTemplates.ts";

const ROLE_LABELS: Record<string, string> = {
  manager: "Manager / Site Manager",
  supervisor: "Supervisor / Team Lead",
  employee: "Employee",
  read_only: "Read-only / Reporting",
};

function generateVerificationCode(): string {
  const randomBuffer = new Uint32Array(1);
  crypto.getRandomValues(randomBuffer);
  return (100000 + (randomBuffer[0] % 900000)).toString();
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

    const gate = await checkInstallationGate(callerClient, supabaseUrl, anonKey, authorizationHeader);
    if (!gate.allowed) {
      return errorResponse(gate.reason ?? "This installation is not covered by a valid license.", 403, "INSTALLATION_BLOCKED");
    }

    const { data: callerRow } = await callerClient
      .from("users")
      .select("id, organization_id")
      .eq("auth_user_id", authUser.id)
      .maybeSingle();
    if (!callerRow) {
      return errorResponse("Caller not found.", 401, "UNAUTHORIZED");
    }

    const { data: effectivePermissions, error: permissionsError } = await callerClient.rpc(
      "get_prosm_time_effective_permissions",
      { p_user_id: callerRow.id }
    );
    if (permissionsError) {
      return errorResponse(permissionsError.message, 500, "PERMISSION_CHECK_FAILED");
    }
    if (!Array.isArray(effectivePermissions) || !effectivePermissions.includes("employees.create")) {
      return errorResponse("You do not have permission to invite employees.", 403, "FORBIDDEN");
    }

    const payload = await request.json().catch(() => ({}));
    const { email, fullName, roleKey } = payload;

    if (!email || typeof email !== "string" || !email.includes("@")) {
      return errorResponse("A valid email is required.", 400, "INVALID_REQUEST");
    }
    if (!fullName || typeof fullName !== "string" || fullName.trim().length === 0) {
      return errorResponse("fullName is required.", 400, "INVALID_REQUEST");
    }
    if (!["manager", "supervisor", "employee", "read_only"].includes(roleKey)) {
      return errorResponse("roleKey must be one of manager, supervisor, employee, read_only.", 400, "INVALID_REQUEST");
    }

    const normalizedEmail = email.trim().toLowerCase();
    const randomPassword = crypto.randomUUID() + crypto.randomUUID();

    const { data: authResult, error: authError } = await serviceClient.auth.admin.createUser({
      email: normalizedEmail,
      password: randomPassword,
      email_confirm: true,
    });
    if (authError || !authResult?.user) {
      return errorResponse(authError?.message ?? "Unable to create this employee's account.", 500, "AUTH_ACCOUNT_CREATE_FAILED");
    }
    const newAuthUserId = authResult.user.id;

    const verificationCode = generateVerificationCode();
    const expiryDays = 7;
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * expiryDays).toISOString();

    const { data: createResult, error: createError } = await serviceClient.rpc("create_invited_prosm_time_user", {
      p_organization_id: callerRow.organization_id,
      p_auth_user_id: newAuthUserId,
      p_actor_user_id: callerRow.id,
      p_role_key: roleKey,
      p_email: normalizedEmail,
      p_full_name: fullName.trim(),
      p_verification_code: verificationCode,
      p_expires_at: expiresAt,
    });

    if (createError || !createResult?.success) {
      try {
        await serviceClient.auth.admin.deleteUser(newAuthUserId);
      } catch (rollbackError) {
        console.error("[invite-user] ROLLBACK AUTH USER failed", rollbackError);
      }
      return errorResponse(createError?.message ?? "Unable to invite this employee.", 500, "INVITE_FAILED");
    }

    const { data: organizationRow } = await serviceClient
      .from("organizations")
      .select("name")
      .eq("id", callerRow.organization_id)
      .maybeSingle();

    // § live UX review, user-directed - "the link button in invite/
    // reset emails is broken (points at localhost) - drop it, the code
    // is enough." No app URL is threaded through anywhere in this flow
    // any more; the verification code is the only real call to action.
    const emailResult = await sendEmail({
      to: normalizedEmail,
      subject: `You're invited to join ${organizationRow?.name ?? "your organization"} on PROSM Time`,
      html: renderInvitationEmail({
        organizationName: organizationRow?.name ?? "your organization",
        inviteeName: fullName.trim(),
        roleLabel: ROLE_LABELS[roleKey] ?? roleKey,
        verificationCode,
        expiryDays,
      }),
      purpose: "user_invitation",
      supabase: serviceClient,
      organizationId: callerRow.organization_id,
      userId: createResult.userId,
    });

    return successResponse({
      userId: createResult.userId,
      email: normalizedEmail,
      verificationCode,
      emailSent: emailResult.sent,
      expiresAt,
    });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Invitation service unavailable.", 500, "INTERNAL_ERROR");
  }
});
