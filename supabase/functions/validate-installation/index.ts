// validate-installation - the installation's own heartbeat: proves its
// identity, refreshes last-seen/version/session tracking, and returns the
// authoritative license state computed with the SERVER clock (License
// Enforcement & Installation Identity phase, user-directed).
//
// The response is what the persistent license warning renders. It is a
// reflection only - denying a protected operation is done by the gate inside
// each protected function, never by this response.
// deno-lint-ignore-file no-explicit-any

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";
import { enforceRateLimits, clientIdentifier } from "../_shared/rateLimit.ts";
import { serviceClient, installationCredentials } from "../_shared/licenseGate.ts";

serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return errorResponse("Method not allowed.", 405, "METHOD_NOT_ALLOWED");
  }

  try {
    const service = serviceClient();
    const { key, secret } = installationCredentials(request);

    const limited = await enforceRateLimits(service, [
      { scope: "validate-installation:ip", identifier: clientIdentifier(request), limit: 120, windowSeconds: 3600, blockSeconds: 900 },
    ]);
    if (limited) return limited;

    let authUserId: string | null = null;
    const authorizationHeader = request.headers.get("authorization");
    if (authorizationHeader) {
      const callerClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { auth: { autoRefreshToken: false, persistSession: false }, global: { headers: { Authorization: authorizationHeader } } }
      );
      const { data: { user } } = await callerClient.auth.getUser();
      authUserId = user?.id ?? null;
    }

    const payload = await request.json().catch(() => ({}));

    const { data, error } = await service.rpc("validate_prosm_time_installation", {
      p_installation_key: key,
      p_installation_secret: secret,
      p_auth_user_id: authUserId,
      p_app_version: typeof payload?.appVersion === "string" ? payload.appVersion : null,
    });

    if (error || !data) {
      return errorResponse(error?.message ?? "Unable to validate this installation.", 400, "INSTALLATION_VALIDATION_FAILED");
    }

    return successResponse({
      state: data.state,
      identified: data.identified,
      allowed: data.allowed,
      graceEndsAt: data.graceEndsAt ?? null,
      graceDaysRemaining: data.graceDaysRemaining ?? null,
      licenseStatus: data.licenseStatus ?? null,
      licenseExpiresAt: data.licenseExpiresAt ?? null,
      protectionVersion: data.protectionVersion ?? null,
      serverTime: data.serverTime,
    });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Installation service unavailable.", 500, "INTERNAL_ERROR");
  }
});
