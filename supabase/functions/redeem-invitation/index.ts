// redeem-invitation - PROSM Time Implementation Master File V3.0,
// WP-04. The invited employee's own entry point - deliberately
// verify_jwt = false (§37: no session exists yet), same posture as
// activate-organization. Validates the real invitation (email +
// verification code, §12) against the database, then sets the real
// password on the already-created Auth account (service role) and
// activates the user row.
//
// § real gap fix, 14-point live-audit - a session-less endpoint
// guessing a 6-digit code needs a server-side rate limit; added here.
// Deliberately NOT collapsed to one generic failure message the way
// password-reset was (20260910150000): "invitation not found / already
// used / expired / wrong code" are real, currently-translated, useful
// distinctions for a legitimately invited employee, and the email
// address here is already known to whoever sent the invite - a
// separate, lower-severity call than the password-reset case.
// deno-lint-ignore-file no-explicit-any

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";
import { clientIdentifier, enforceRateLimits } from "../_shared/rateLimit.ts";

serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return errorResponse("Method not allowed.", 405, "METHOD_NOT_ALLOWED");
  }

  try {
    const payload = await request.json().catch(() => ({}));
    const { email, verificationCode, newPassword } = payload;

    if (!email || typeof email !== "string") {
      return errorResponse("email is required.", 400, "INVALID_REQUEST");
    }
    if (!verificationCode || typeof verificationCode !== "string") {
      return errorResponse("verificationCode is required.", 400, "INVALID_REQUEST");
    }
    if (!newPassword || typeof newPassword !== "string" || newPassword.length < 8) {
      return errorResponse("newPassword must be at least 8 characters.", 400, "INVALID_REQUEST");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const normalizedEmail = email.trim().toLowerCase();
    const rateLimited = await enforceRateLimits(serviceClient, [
      { scope: "invitation_redeem_email", identifier: normalizedEmail, limit: 5, windowSeconds: 900, blockSeconds: 1800 },
      { scope: "invitation_redeem_ip", identifier: clientIdentifier(request), limit: 20, windowSeconds: 3600, blockSeconds: 3600 },
    ]);
    if (rateLimited) return rateLimited;

    const { data: redeemResult, error: redeemError } = await serviceClient.rpc("redeem_prosm_time_invitation", {
      p_email: normalizedEmail,
      p_verification_code: verificationCode.trim(),
    });

    if (redeemError || !redeemResult?.success) {
      return errorResponse(redeemError?.message ?? "Unable to redeem this invitation.", 400, "REDEEM_FAILED");
    }

    const { error: updatePasswordError } = await serviceClient.auth.admin.updateUserById(redeemResult.authUserId, {
      password: newPassword,
    });
    if (updatePasswordError) {
      // The invitation is already marked CONSUMED and the user row is
      // already ACTIVE at this point - a failed password set is a real,
      // visible, retriable ops issue (the account exists but the
      // employee doesn't yet know a working password), not a reason to
      // pretend redemption didn't happen.
      return errorResponse(
        `Invitation redeemed but the password could not be set: ${updatePasswordError.message}. Contact your administrator.`,
        500,
        "PASSWORD_SET_FAILED"
      );
    }

    return successResponse({ userId: redeemResult.userId });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Invitation service unavailable.", 500, "INTERNAL_ERROR");
  }
});
