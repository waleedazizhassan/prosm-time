// register-installation - issues the server-recognized Installation Identity
// for one PROSM Time installation (License Enforcement & Installation
// Identity phase, user-directed).
//
// The key and secret are minted by Postgres, returned exactly once, and only
// their hash is retained. A session is optional here (a fresh install
// registers before anyone signs in); when one is present the installation is
// bound to that user's own organization, derived server-side.
// deno-lint-ignore-file no-explicit-any

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";
import { enforceRateLimits, clientIdentifier } from "../_shared/rateLimit.ts";
import { serviceClient } from "../_shared/licenseGate.ts";

serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return errorResponse("Method not allowed.", 405, "METHOD_NOT_ALLOWED");
  }

  try {
    const service = serviceClient();

    const limited = await enforceRateLimits(service, [
      { scope: "register-installation:ip", identifier: clientIdentifier(request), limit: 10, windowSeconds: 3600, blockSeconds: 3600 },
    ]);
    if (limited) return limited;

    const payload = await request.json().catch(() => ({}));
    const { platform, appVersion, deviceLabel } = payload ?? {};

    // The organization is never taken from the request body - it is derived
    // from the caller's own verified session when there is one.
    let authUserId: string | null = null;
    const authorizationHeader = request.headers.get("authorization");
    if (authorizationHeader) {
      const { createClient } = await import("npm:@supabase/supabase-js@2");
      const callerClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { auth: { autoRefreshToken: false, persistSession: false }, global: { headers: { Authorization: authorizationHeader } } }
      );
      const { data: { user } } = await callerClient.auth.getUser();
      authUserId = user?.id ?? null;
    }

    const { data, error } = await service.rpc("register_prosm_time_installation", {
      p_platform: typeof platform === "string" ? platform : "unknown",
      p_app_version: typeof appVersion === "string" ? appVersion : null,
      p_device_label: typeof deviceLabel === "string" ? deviceLabel : null,
      p_auth_user_id: authUserId,
    });

    if (error || !data?.success) {
      return errorResponse(error?.message ?? "Unable to register this installation.", 400, "INSTALLATION_REGISTRATION_FAILED");
    }

    return successResponse({
      installationKey: data.installationKey,
      installationSecret: data.installationSecret,
    });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Installation service unavailable.", 500, "INTERNAL_ERROR");
  }
});
