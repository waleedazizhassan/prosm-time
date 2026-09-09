// redeem-invitation - PROSM Time Implementation Master File V3.0,
// WP-04. The invited employee's own entry point - deliberately
// verify_jwt = false (§37: no session exists yet), same posture as
// activate-organization. Validates the real invitation (email +
// verification code, §12) against the database, then sets the real
// password on the already-created Auth account (service role) and
// activates the user row.
// deno-lint-ignore-file no-explicit-any

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";
import { clientIdentifier, enforceRateLimits, padResponseTime } from "../_shared/rateLimit.ts";

// Security Hardening phase (user-directed): session-less endpoint, so
// abuse control is server-side. One neutral failure message for every
// user-caused failure - an unknown email must not be distinguishable
// from a wrong invitation code.
const GENERIC_FAILURE = "This invitation code is invalid or has expired. Ask your administrator for a new invitation.";

serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return errorResponse("Method not allowed.", 405, "METHOD_NOT_ALLOWED");
  }

  const startedAt = Date.now();

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

    const rateLimited = await enforceRateLimits(serviceClient, [
      { scope: "invitation_redeem_email", identifier: email.trim().toLowerCase(), limit: 5, windowSeconds: 900, blockSeconds: 1800 },
      { scope: "invitation_redeem_ip", identifier: clientIdentifier(request), limit: 20, windowSeconds: 3600, blockSeconds: 3600 },
    ]);
    if (rateLimited) {
      await padResponseTime(startedAt);
      return rateLimited;
    }

    const { data: redeemResult, error: redeemError } = await serviceClient.rpc("redeem_prosm_time_invitation", {
      p_email: email.trim().toLowerCase(),
      p_verification_code: verificationCode.trim(),
    });

    if (redeemError || !redeemResult?.success) {
      if (redeemError) console.error("[redeem-invitation] redeem RPC failed", redeemError.message);
      await padResponseTime(startedAt);
      return errorResponse(GENERIC_FAILURE, 400, "REDEEM_FAILED");
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
      console.error("[redeem-invitation] password set failed", updatePasswordError.message);
      await padResponseTime(startedAt);
      return errorResponse(
        "Invitation redeemed but the password could not be set. Contact your administrator.",
        500,
        "PASSWORD_SET_FAILED"
      );
    }

    await padResponseTime(startedAt);
    return successResponse({ userId: redeemResult.userId });
  } catch (error: any) {
    console.error("[redeem-invitation] unexpected failure", error?.message);
    await padResponseTime(startedAt);
    return errorResponse("Invitation service unavailable.", 500, "INTERNAL_ERROR");
  }
});
