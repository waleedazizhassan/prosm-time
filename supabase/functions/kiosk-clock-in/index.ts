// kiosk-clock-in - WP-18 (§13.1, §35). Forwards the operating browser
// session (whoever is signed in on the shared device) to
// kiosk_clock_in_prosm_time_attendance(), which authenticates the
// EMPLOYEE being clocked in by their own PIN (not by the caller's
// identity) and uses the site's own fixed coordinates rather than any
// client-supplied location.
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
    const { siteId, employeeUserId, pin, projectId, idempotencyKey, clientReportedAt } = payload;

    if (!siteId || typeof siteId !== "string") return errorResponse("siteId is required.", 400, "INVALID_REQUEST");
    if (!employeeUserId || typeof employeeUserId !== "string") return errorResponse("employeeUserId is required.", 400, "INVALID_REQUEST");
    if (!pin || typeof pin !== "string") return errorResponse("pin is required.", 400, "INVALID_REQUEST");
    if (!idempotencyKey || typeof idempotencyKey !== "string") return errorResponse("idempotencyKey is required.", 400, "INVALID_REQUEST");

    const { data, error } = await callerClient.rpc("kiosk_clock_in_prosm_time_attendance", {
      p_site_id: siteId,
      p_employee_user_id: employeeUserId,
      p_pin: pin,
      p_idempotency_key: idempotencyKey,
      p_project_id: projectId ?? null,
      p_client_reported_at: clientReportedAt ?? null,
    });

    if (error || !data?.success) return errorResponse(error?.message ?? "Unable to clock in.", 400, "KIOSK_CLOCK_IN_FAILED");
    return successResponse({ sessionId: data.sessionId, eventId: data.eventId, replay: data.replay });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Kiosk service unavailable.", 500, "INTERNAL_ERROR");
  }
});
