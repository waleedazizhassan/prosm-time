// purge-location-samples - WP-22 (§24: "Configurable retention/
// deletion for location... evidence"). Mirrors purge-camera-evidence's
// own posture exactly: no automatic schedule wired up this pass (a
// real pg_cron trigger is future scope, deliberately not built here) -
// invoked manually or by whatever scheduler is set up later, always
// with the service role key. verify_jwt=false because this must never
// be reachable by an ordinary authenticated org member; authorization
// is the underlying RPC's own service_role-only grant, not a manual
// key comparison.
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
    const suppliedKey = authorizationHeader.replace(/^Bearer\s+/i, "");
    const callerClient = createClient(supabaseUrl, suppliedKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: authorizationHeader } },
    });

    const { data, error } = await callerClient.rpc("purge_prosm_time_expired_location_samples");
    if (error || !data?.success) {
      return errorResponse("This endpoint requires the service role key.", 401, "UNAUTHORIZED");
    }

    return successResponse({ deletedCount: data.deletedCount });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Location sample purge service unavailable.", 500, "INTERNAL_ERROR");
  }
});
