// change-site - live UX review, user-directed (mid-shift "Change
// Site" workflow). Forwards the caller's own session to
// change_prosm_time_site(), same shape as start-break/end-break.
// user-directed follow-up: newSiteId is now optional - a null site
// (walk-in style, same as clock-in's own no-site option) requires
// manualLocationLabel and a real GPS sample, never a photo.
// § real gap fix, 14-point live-audit - the user's own spec required
// Change Site to be its own independent control, not routed through
// Break/Pause. breakId is now optional: omit it to move the caller's
// currently open session directly, no break required at all.
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";

serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return errorResponse("Method not allowed.", 405, "METHOD_NOT_ALLOWED");

  try {
    const authorizationHeader = request.headers.get("authorization");
    if (!authorizationHeader) return errorResponse("Missing Authorization header.", 401, "UNAUTHORIZED");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const callerClient = createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: authorizationHeader } },
    });

    const {
      data: { user: authUser },
    } = await callerClient.auth.getUser();
    if (!authUser) return errorResponse("Invalid or expired session.", 401, "UNAUTHORIZED");

    const payload = await request.json().catch(() => ({}));
    const { breakId, newSiteId, latitude, longitude, accuracyMeters, manualLocationLabel } = payload;
    if (breakId !== null && breakId !== undefined && typeof breakId !== "string") return errorResponse("breakId must be a string or null.", 400, "INVALID_REQUEST");
    if (newSiteId !== null && newSiteId !== undefined && typeof newSiteId !== "string") return errorResponse("newSiteId must be a string or null.", 400, "INVALID_REQUEST");

    const { data, error } = await callerClient.rpc("change_prosm_time_site", {
      p_break_id: breakId || null,
      p_new_site_id: newSiteId || null,
      p_latitude: latitude ?? null,
      p_longitude: longitude ?? null,
      p_accuracy_meters: accuracyMeters ?? null,
      p_manual_location_label: manualLocationLabel ?? null,
    });

    if (error || !data?.success) return errorResponse(error?.message ?? "Unable to change site.", 400, "CHANGE_SITE_FAILED");
    return successResponse({ siteChangeId: data.siteChangeId, newSiteId: data.newSiteId, maxDurationExceeded: data.maxDurationExceeded });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Site change service unavailable.", 500, "INTERNAL_ERROR");
  }
});
