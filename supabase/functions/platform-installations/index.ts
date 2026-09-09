// platform-installations - the service-to-service surface PROSM's control
// plane uses to discover and administer PROSM Time installations (License
// Enforcement & Installation Identity phase, user-directed).
//
// It is NOT reachable with a user session, an anon key, or an authenticated
// employee's JWT: the only accepted credential is the PROSM Management
// integration key, compared in constant time. Everything it does is executed
// by service_role-only RPCs and written to the installation's security
// history. This file lives in PROSM Time and changes nothing in PROSM
// Management.
// deno-lint-ignore-file no-explicit-any

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";
import { enforceRateLimits, clientIdentifier } from "../_shared/rateLimit.ts";
import { serviceClient } from "../_shared/licenseGate.ts";

function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left[index] ^ right[index];
  }
  return mismatch === 0;
}

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
      { scope: "platform-installations:ip", identifier: clientIdentifier(request), limit: 120, windowSeconds: 3600, blockSeconds: 900 },
    ]);
    if (limited) return limited;

    const expectedKey = Deno.env.get("PROSM_MANAGEMENT_API_KEY");
    const providedKey = request.headers.get("x-prosm-api-key");
    if (!expectedKey || !providedKey || !timingSafeEqual(providedKey, expectedKey)) {
      return errorResponse("Unauthorized.", 401, "UNAUTHORIZED");
    }

    const payload = await request.json().catch(() => ({}));
    const action = typeof payload?.action === "string" ? payload.action : "";
    const installationKey = typeof payload?.installationKey === "string" ? payload.installationKey : null;

    switch (action) {
      case "listInstallations": {
        const { data, error } = await service.rpc("list_prosm_time_installations", {
          p_limit: typeof payload?.limit === "number" ? payload.limit : 200,
        });
        if (error) return errorResponse(error.message, 400, "LIST_FAILED");
        return successResponse({ installations: data.installations });
      }
      case "installationHistory": {
        if (!installationKey) return errorResponse("installationKey is required.", 400, "INVALID_REQUEST");
        const { data, error } = await service.rpc("get_prosm_time_installation_history", {
          p_installation_key: installationKey,
          p_limit: typeof payload?.limit === "number" ? payload.limit : 100,
        });
        if (error) return errorResponse(error.message, 400, "HISTORY_FAILED");
        return successResponse({ events: data.events });
      }
      case "setInstallationState": {
        if (!installationKey) return errorResponse("installationKey is required.", 400, "INVALID_REQUEST");
        const { data, error } = await service.rpc("admin_set_prosm_time_installation_state", {
          p_installation_key: installationKey,
          p_admin_state: typeof payload?.state === "string" ? payload.state : "",
          p_reason: typeof payload?.reason === "string" ? payload.reason : null,
        });
        if (error) return errorResponse(error.message, 400, "STATE_CHANGE_FAILED");
        return successResponse({ state: data.state });
      }
      case "terminateSessions": {
        if (!installationKey) return errorResponse("installationKey is required.", 400, "INVALID_REQUEST");
        const { data, error } = await service.rpc("terminate_prosm_time_installation_sessions", {
          p_installation_key: installationKey,
        });
        if (error) return errorResponse(error.message, 400, "TERMINATE_FAILED");
        return successResponse({ terminated: data.terminated });
      }
      case "protectionState": {
        const { data, error } = await service.rpc("get_prosm_time_protection_state", {});
        if (error) return errorResponse(error.message, 400, "PROTECTION_STATE_FAILED");
        return successResponse(data);
      }
      default:
        return errorResponse("Unsupported action.", 400, "UNSUPPORTED_ACTION");
    }
  } catch (error: any) {
    return errorResponse(error?.message ?? "Installation administration unavailable.", 500, "INTERNAL_ERROR");
  }
});
