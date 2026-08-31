// trigger-sos-alert - PROSM Time Implementation Master File V3.0,
// WP-10 (§18: "SOS/Emergency action... is reachable at all times
// during an active session"; §35: "Supabase Edge Functions handle...
// SOS alerts... and other sensitive orchestration"). Forwards the
// caller's own session to trigger_prosm_time_sos_alert(), which
// re-validates the caller is the presence session's own subject and
// that the session is genuinely active before recording anything -
// this Edge Function is the required entry point, not a bypass of
// that check. Priority delivery/escalation of the alert is explicitly
// WP-13's own job ("Notifications... SOS priority delivery") - not
// built here.
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
    const authorizationHeader = request.headers.get("authorization");
    if (!authorizationHeader) {
      return errorResponse("Missing Authorization header.", 401, "UNAUTHORIZED");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const callerClient = createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: authorizationHeader } },
    });

    const {
      data: { user: authUser },
    } = await callerClient.auth.getUser();
    if (!authUser) {
      return errorResponse("Invalid or expired session.", 401, "UNAUTHORIZED");
    }

    const payload = await request.json().catch(() => ({}));
    const { presenceSessionId, latitude, longitude, accuracyMeters } = payload;

    if (!presenceSessionId || typeof presenceSessionId !== "string") {
      return errorResponse("presenceSessionId is required.", 400, "INVALID_REQUEST");
    }

    const { data, error } = await callerClient.rpc("trigger_prosm_time_sos_alert", {
      p_presence_session_id: presenceSessionId,
      p_latitude: typeof latitude === "number" ? latitude : null,
      p_longitude: typeof longitude === "number" ? longitude : null,
      p_accuracy_meters: typeof accuracyMeters === "number" ? accuracyMeters : null,
    });

    if (error || !data?.success) {
      return errorResponse(error?.message ?? "Unable to trigger an SOS alert.", 400, "SOS_TRIGGER_FAILED");
    }

    return successResponse({ alertId: data.alertId });
  } catch (error: any) {
    return errorResponse(error?.message ?? "SOS service unavailable.", 500, "INTERNAL_ERROR");
  }
});
