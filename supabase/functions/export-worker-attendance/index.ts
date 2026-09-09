// export-worker-attendance - read-only external-workforce attendance
// export, mirrors export-attendance's own exact API-key-authentication
// pattern (authenticate_prosm_time_api_key, service_role-only) - this
// is what PROSM Projects' own sync pulls from to match external
// contractor workers by worker_number.
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";

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

    const { data: organizationId, error: authError } = await serviceClient.rpc("authenticate_prosm_time_api_key", { p_raw_key: rawKey });
    if (authError) return errorResponse(authError.message, 500, "INTERNAL_ERROR");
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

    const { data, error } = await serviceClient.rpc("list_prosm_time_worker_attendance_export", {
      p_organization_id: organizationId,
      p_since: since.toISOString(),
      p_until: until.toISOString(),
    });

    if (error) return errorResponse(error.message, 500, "INTERNAL_ERROR");

    const records = (data ?? []).map((row: any) => ({
      entryId: row.entry_id,
      workerName: row.worker_name,
      workerNumber: row.worker_number,
      siteName: row.site_name,
      clockInAt: row.clock_in_at,
      clockOutAt: row.clock_out_at,
      clockInLatitude: row.clock_in_latitude,
      clockInLongitude: row.clock_in_longitude,
    }));

    return successResponse({ since: since.toISOString(), until: until.toISOString(), count: records.length, records });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Worker attendance export service unavailable.", 500, "INTERNAL_ERROR");
  }
});
