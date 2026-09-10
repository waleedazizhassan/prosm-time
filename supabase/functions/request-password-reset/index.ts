// request-password-reset - PROSM Time live UX review, user-directed:
// "there should be a password-reset feature." Mirrors invite-user's
// own 6-digit-code + email pattern (WP-04), one table over
// (password_reset_requests, § migration 20260901210000). Deliberately
// verify_jwt = false - the whole point is "I forgot my password and
// can't sign in", same posture as redeem-invitation/activate-organization.
//
// Always responds success:true with the same generic message whether
// or not the email belongs to a real active account - the RPC itself
// tells this function that (reason: NO_ACTIVE_ACCOUNT), but that fact
// never reaches the client, so this endpoint gives no email-
// enumeration signal. Real email delivery is a soft dependency
// (sendEmail(), § _shared/emailService.ts) exactly like invite-user.
//
// Security Hardening phase (user-directed): because this endpoint is
// session-less, abuse control has to be server-side - per-IP and
// per-email rate limits (§ _shared/rateLimit.ts, enforced in Postgres)
// and a padded response time so the "account exists" branch does not
// finish measurably faster than the "no such account" branch.
// deno-lint-ignore-file no-explicit-any

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";
import { sendEmail } from "../_shared/emailService.ts";
import { renderPasswordResetEmail } from "../_shared/emailTemplates.ts";
import { clientIdentifier, enforceRateLimits, padResponseTime } from "../_shared/rateLimit.ts";

const GENERIC_MESSAGE = "If an account exists for this email, a password reset code has been sent.";
const EXPIRY_MINUTES = 30;

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

  const startedAt = Date.now();

  try {
    const payload = await request.json().catch(() => ({}));
    const { email } = payload;

    if (!email || typeof email !== "string" || !email.includes("@")) {
      return errorResponse("A valid email is required.", 400, "INVALID_REQUEST");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const normalizedEmail = email.trim().toLowerCase();

    const rateLimited = await enforceRateLimits(serviceClient, [
      // A single address may not be flooded with reset codes...
      { scope: "password_reset_request_email", identifier: normalizedEmail, limit: 3, windowSeconds: 900, blockSeconds: 900 },
      // ...and one source may not sweep many addresses either.
      { scope: "password_reset_request_ip", identifier: clientIdentifier(request), limit: 10, windowSeconds: 3600, blockSeconds: 3600 },
    ]);
    if (rateLimited) {
      await padResponseTime(startedAt);
      return rateLimited;
    }

    const verificationCode = generateVerificationCode();
    const expiresAt = new Date(Date.now() + 1000 * 60 * EXPIRY_MINUTES).toISOString();

    const { data: requestResult, error: requestError } = await serviceClient.rpc("request_prosm_time_password_reset", {
      p_email: normalizedEmail,
      p_verification_code: verificationCode,
      p_expires_at: expiresAt,
    });

    if (requestError) {
      // Never surface the internal reason here - a failing lookup must
      // look exactly like a successful one from outside.
      console.error("[request-password-reset] RPC failed", requestError.message);
      await padResponseTime(startedAt);
      return successResponse({ message: GENERIC_MESSAGE, email: normalizedEmail });
    }

    if (requestResult?.success) {
      // § live UX review, user-directed - the reset link always
      // resolved to a dead localhost fallback; the code alone is the
      // real call to action now (see _shared/emailTemplates.ts).
      await sendEmail({
        to: normalizedEmail,
        subject: "Reset your PROSM Time password",
        html: renderPasswordResetEmail({
          fullName: requestResult.fullName ?? "there",
          verificationCode,
          expiryMinutes: EXPIRY_MINUTES,
        }),
        purpose: "password_reset",
        supabase: serviceClient,
        organizationId: requestResult.organizationId,
        userId: requestResult.userId,
      });
    }

    await padResponseTime(startedAt);
    return successResponse({ message: GENERIC_MESSAGE, email: normalizedEmail });
  } catch (error: any) {
    console.error("[request-password-reset] unexpected failure", error?.message);
    await padResponseTime(startedAt);
    return errorResponse("Password reset service unavailable.", 500, "INTERNAL_ERROR");
  }
});
