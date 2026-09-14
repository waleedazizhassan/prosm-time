// export-leave - PROSM Finance's payroll bridge (user-directed,
// 2026-09-14). Same auth shape as export-worker-rates/export-allowances
// (payroll:read scope required). Returns APPROVED leave requests of
// EVERY leave_type overlapping the window - PROSM Finance decides
// which types (e.g. 'unpaid') actually reduce pay, this endpoint just
// relays the real, already-decided truth.
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

    const exportRateLimited = await enforceRateLimits(serviceClient, [
      { scope: "export_leave_ip", identifier: clientIdentifier(request), limit: 60, windowSeconds: 300, blockSeconds: 900 },
      { scope: "export_leave_key", identifier: await hashIdentifier(rawKey), limit: 60, windowSeconds: 300, blockSeconds: 900 },
    ]);
    if (exportRateLimited) return exportRateLimited;

    const { data: organizationId, error: authError } = await serviceClient.rpc("authenticate_prosm_time_api_key_with_scope", {
      p_raw_key: rawKey,
      p_required_scope: "payroll:read",
    });
    if (authError) return errorResponse("Invalid or revoked API key.", 401, "UNAUTHORIZED");
    if (!organizationId) return errorResponse("Invalid or revoked API key, or this key does not have payroll:read scope.", 401, "UNAUTHORIZED");

    const url = new URL(request.url);
    const sinceParam = url.searchParams.get("since");
    const untilParam = url.searchParams.get("until");

    const until = untilParam ? new Date(untilParam) : new Date();
    const defaultSince = new Date(until.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const since = sinceParam ? new Date(sinceParam) : defaultSince;

    if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
      return errorResponse("'since'/'until' must be valid ISO date strings.", 400, "INVALID_REQUEST");
    }
    if (until.getTime() < since.getTime()) {
      return errorResponse("'until' must not be before 'since'.", 400, "INVALID_REQUEST");
    }
    if (until.getTime() - since.getTime() > MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
      return errorResponse(`The requested window exceeds the ${MAX_WINDOW_DAYS}-day maximum - request a shorter range.`, 400, "WINDOW_TOO_LARGE");
    }

    const { data, error } = await serviceClient.rpc("list_prosm_time_leave_export", {
      p_organization_id: organizationId,
      p_since: since.toISOString().slice(0, 10),
      p_until: until.toISOString().slice(0, 10),
    });
    if (error) return errorResponse(error.message, 500, "INTERNAL_ERROR");

    const records = (data ?? []).map((row: any) => ({
      userId: row.user_id,
      employeeName: row.employee_name,
      employeeEmail: row.employee_email,
      leaveType: row.leave_type,
      startDate: row.start_date,
      endDate: row.end_date,
      daysCount: Number(row.days_count ?? 0),
    }));

    return successResponse({ since: since.toISOString().slice(0, 10), until: until.toISOString().slice(0, 10), count: records.length, records });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Leave export service unavailable.", 500, "INTERNAL_ERROR");
  }
});
