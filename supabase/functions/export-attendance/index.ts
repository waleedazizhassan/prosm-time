// export-attendance - PROSM Time's real, read-only integration surface
// (user-directed: sibling PROSM products - PROSM Projects first - pull
// verified attendance instead of hand-typing it). verify_jwt=false
// (config.toml) because the caller is an external product's own Edge
// Function, never an ordinary org member with a Supabase session - the
// Authorization header carries this org's own api_keys plaintext
// value, not a Supabase JWT at all. Authorization is not a manual
// string comparison - authenticate_prosm_time_api_key (service_role-
// only) re-hashes the raw key and looks it up itself, exactly the same
// "the RPC's own grant is the real gate" posture as purge-camera-
// evidence's own header comment.
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";
import { clientIdentifier, enforceRateLimits, hashIdentifier } from "../_shared/rateLimit.ts";

const MAX_WINDOW_DAYS = 90;
const DEFAULT_WINDOW_DAYS = 30;

serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "GET") return errorResponse("Method not allowed.", 405, "METHOD_NOT_ALLOWED");

  try {
    const authorizationHeader = request.headers.get("authorization");
    if (!authorizationHeader?.startsWith("Bearer ")) {
      return errorResponse("Missing or malformed Authorization header - expected 'Bearer <api key>'.", 401, "UNAUTHORIZED");
    }
    const rawKey = authorizationHeader.slice("Bearer ".length).trim();

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Security Hardening phase (user-directed): an integration surface
    // that returns attendance records is worth both guessing at and
    // scraping, so the attempt rate is capped server-side per caller
    // and per presented key BEFORE the key is looked up. The raw key is
    // never used as an identifier - only its SHA-256.
    const exportRateLimited = await enforceRateLimits(serviceClient, [
      { scope: "export_attendance_ip", identifier: clientIdentifier(request), limit: 60, windowSeconds: 300, blockSeconds: 900 },
      { scope: "export_attendance_key", identifier: await hashIdentifier(rawKey), limit: 60, windowSeconds: 300, blockSeconds: 900 },
    ]);
    if (exportRateLimited) return exportRateLimited;

    const { data: organizationId, error: authError } = await serviceClient.rpc("authenticate_prosm_time_api_key", { p_raw_key: rawKey });
    if (authError) {
      console.error("[export-attendance] api key auth failed", authError.message);
      return errorResponse("Invalid or revoked API key.", 401, "UNAUTHORIZED");
    }
    if (!organizationId) return errorResponse("Invalid or revoked API key.", 401, "UNAUTHORIZED");

    const url = new URL(request.url);
    const sinceParam = url.searchParams.get("since");
    const untilParam = url.searchParams.get("until");

    const until = untilParam ? new Date(untilParam) : new Date();
    const defaultSince = new Date(until.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const since = sinceParam ? new Date(sinceParam) : defaultSince;

    if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
      return errorResponse("'since'/'until' must be valid ISO date-time strings.", 400, "INVALID_REQUEST");
    }
    if (until.getTime() < since.getTime()) {
      return errorResponse("'until' must not be before 'since'.", 400, "INVALID_REQUEST");
    }
    const windowMs = until.getTime() - since.getTime();
    if (windowMs > MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
      return errorResponse(`The requested window exceeds the ${MAX_WINDOW_DAYS}-day maximum - request a shorter range.`, 400, "WINDOW_TOO_LARGE");
    }

    const { data, error } = await serviceClient.rpc("list_prosm_time_attendance_export", {
      p_organization_id: organizationId,
      p_since: since.toISOString(),
      p_until: until.toISOString(),
    });

    if (error) return errorResponse(error.message, 500, "INTERNAL_ERROR");

    const records = (data ?? []).map((row: any) => ({
      sessionId: row.session_id,
      employeeName: row.employee_name,
      employeeEmail: row.employee_email,
      siteName: row.site_name,
      clockInAt: row.clock_in_at,
      clockOutAt: row.clock_out_at,
      workedMinutes: Number(row.worked_minutes ?? 0),
      breakMinutes: Number(row.break_minutes ?? 0),
      overtimeMinutes: Number(row.overtime_minutes ?? 0),
      verified: row.verified === true,
      hasPhotoEvidence: row.has_photo_evidence === true,
    }));

    return successResponse({ since: since.toISOString(), until: until.toISOString(), count: records.length, records });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Attendance export service unavailable.", 500, "INTERNAL_ERROR");
  }
});
