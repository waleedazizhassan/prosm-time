// export-worker-rates - PROSM Time's compensation export surface for
// PROSM Finance (user-directed, 2026-09-14: Finance needs real labor
// cost = hours × rate, and this repo has no rate concept anywhere
// else). Deliberately its OWN endpoint, not folded into
// export-worker-attendance/export-attendance - a key without
// payroll:read scope structurally cannot reach compensation data even
// by accident, since authenticate_prosm_time_api_key_with_scope
// rejects any key whose scope isn't exactly 'payroll:read'.
// verify_jwt=false (config.toml), same reasoning as export-attendance:
// the caller is another product's Edge Function presenting this org's
// own api_keys plaintext value, never an ordinary Supabase session.
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

    // Same server-side rate limiting posture as export-attendance -
    // compensation data is at least as worth guessing/scraping.
    const exportRateLimited = await enforceRateLimits(serviceClient, [
      { scope: "export_worker_rates_ip", identifier: clientIdentifier(request), limit: 60, windowSeconds: 300, blockSeconds: 900 },
      { scope: "export_worker_rates_key", identifier: await hashIdentifier(rawKey), limit: 60, windowSeconds: 300, blockSeconds: 900 },
    ]);
    if (exportRateLimited) return exportRateLimited;

    const { data: organizationId, error: authError } = await serviceClient.rpc("authenticate_prosm_time_api_key_with_scope", {
      p_raw_key: rawKey,
      p_required_scope: "payroll:read",
    });
    if (authError) {
      console.error("[export-worker-rates] api key auth failed", authError.message);
      return errorResponse("Invalid or revoked API key.", 401, "UNAUTHORIZED");
    }
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
    const windowMs = until.getTime() - since.getTime();
    if (windowMs > MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
      return errorResponse(`The requested window exceeds the ${MAX_WINDOW_DAYS}-day maximum - request a shorter range.`, 400, "WINDOW_TOO_LARGE");
    }

    const { data, error } = await serviceClient.rpc("list_prosm_time_worker_rates_export", {
      p_organization_id: organizationId,
      p_since: since.toISOString().slice(0, 10),
      p_until: until.toISOString().slice(0, 10),
    });

    if (error) return errorResponse(error.message, 500, "INTERNAL_ERROR");

    const records = (data ?? []).map((row: any) => ({
      workerType: row.worker_type,
      workerId: row.worker_id,
      workerName: row.worker_name,
      workerEmail: row.worker_email,
      workerNumber: row.worker_number,
      rateType: row.rate_type,
      rateAmount: Number(row.rate_amount ?? 0),
      currency: row.currency,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
    }));

    return successResponse({ since: since.toISOString().slice(0, 10), until: until.toISOString().slice(0, 10), count: records.length, records });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Worker rates export service unavailable.", 500, "INTERNAL_ERROR");
  }
});
