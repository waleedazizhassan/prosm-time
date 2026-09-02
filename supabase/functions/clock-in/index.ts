// clock-in - PROSM Time Implementation Master File V3.0, WP-06 (§17,
// §35: "Supabase Edge Functions handle Clock In, Clock Out..."). This
// is the one entry point every future attendance-adjacent package
// (camera evidence upload, geofence validation, presence-session
// kickoff) hooks into - today it forwards the caller's own session to
// clock_in_prosm_time_attendance(), which derives the caller itself
// (current_prosm_time_user_id()) and does every real check (site
// assignment, project assignment, no already-open session,
// idempotent-replay) server-side. The client never decides success -
// it only supplies what it captured (site/project choice, an
// idempotency key it generated once and retries with, and an
// unvalidated location sample for later packages to make use of).
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
    const { siteId, projectId, idempotencyKey, clientReportedAt, latitude, longitude, accuracyMeters, manualLocationLabel } = payload;

    // § live UX review, user-directed - site is now optional: an
    // employee can clock in at their real current location even when
    // it isn't a registered site. siteId/projectId, when present,
    // still go through every existing WP-06 check (site assignment,
    // project-at-site, geofence) unchanged server-side.
    if (siteId !== undefined && siteId !== null && typeof siteId !== "string") {
      return errorResponse("siteId must be a string when provided.", 400, "INVALID_REQUEST");
    }
    if (!idempotencyKey || typeof idempotencyKey !== "string") {
      return errorResponse("idempotencyKey is required.", 400, "INVALID_REQUEST");
    }
    // § live UX review, user-directed - "won't accept clock-in unless
    // I type the workplace name": when no site is selected, a
    // free-text workplace label is required here too (the RPC itself
    // re-checks this server-side - this is just a fast, clear 400
    // instead of a raised-exception round trip for the obvious case).
    if (!siteId && (!manualLocationLabel || typeof manualLocationLabel !== "string" || manualLocationLabel.trim().length === 0)) {
      return errorResponse("manualLocationLabel is required when no site is selected.", 400, "INVALID_REQUEST");
    }

    const { data, error } = await callerClient.rpc("clock_in_prosm_time_attendance", {
      p_idempotency_key: idempotencyKey,
      p_site_id: siteId || null,
      p_project_id: projectId ?? null,
      p_client_reported_at: clientReportedAt ?? null,
      p_latitude: typeof latitude === "number" ? latitude : null,
      p_longitude: typeof longitude === "number" ? longitude : null,
      p_accuracy_meters: typeof accuracyMeters === "number" ? accuracyMeters : null,
      p_manual_location_label: siteId ? null : (manualLocationLabel as string).trim(),
    });

    if (error || !data?.success) {
      return errorResponse(error?.message ?? "Unable to clock in.", 400, "CLOCK_IN_FAILED");
    }

    return successResponse({ sessionId: data.sessionId, eventId: data.eventId, replay: data.replay, presenceSessionId: data.presenceSessionId ?? null });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Attendance service unavailable.", 500, "INTERNAL_ERROR");
  }
});
