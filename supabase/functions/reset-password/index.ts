// reset-password - PROSM Time live UX review, user-directed password-
// reset feature. Deliberately verify_jwt = false - same posture as
// redeem-invitation (no session exists yet). Validates the emailed
// code server-side (redeem_prosm_time_password_reset), then sets the
// real password on the existing Auth account (service role) - mirrors
// redeem-invitation's own two-step "validate DB row, then
// auth.admin.updateUserById" shape exactly.
// deno-lint-ignore-file no-explicit-any

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";

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

    const { data: redeemResult, error: redeemError } = await serviceClient.rpc("redeem_prosm_time_password_reset", {
      p_email: email.trim().toLowerCase(),
      p_verification_code: verificationCode.trim(),
    });

    if (redeemError || !redeemResult?.success) {
      return errorResponse(redeemError?.message ?? "Unable to reset this password.", 400, "RESET_FAILED");
    }

    const { error: updatePasswordError } = await serviceClient.auth.admin.updateUserById(redeemResult.authUserId, {
      password: newPassword,
    });
    if (updatePasswordError) {
      // The code is already CONSUMED at this point - a failed password
      // set is a real, visible, retriable ops issue, not a reason to
      // pretend the reset didn't happen (same posture as redeem-invitation).
      return errorResponse(`Reset code verified but the password could not be set: ${updatePasswordError.message}. Please try again.`, 500, "PASSWORD_SET_FAILED");
    }

    return successResponse({ userId: redeemResult.userId });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Password reset service unavailable.", 500, "INTERNAL_ERROR");
  }
});
