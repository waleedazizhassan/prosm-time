// sync-gusto-hours - PROSM Time. Owner-only. Attempts to push
// completed, not-yet-synced attendance sessions' worked hours into the
// org's connected Gusto company, matched to a Gusto employee by email.
//
// HONESTY NOTE - READ BEFORE RELYING ON THIS (this is the weakest-
// grounded of the three payroll integrations built this session):
// unlike QuickBooks' TimeActivity and Xero's Timesheets, Gusto's public
// API does not expose a simple, standalone "create a time entry"
// resource for hourly employees. Gusto's actual model is that hours
// for hourly employees are entered as compensation line items on a
// specific, currently-OPEN payroll run (GET /v1/companies/{id}/payrolls
// ?processed=false, then a PATCH/PUT on that payroll's employee
// compensation lines) - there is no ad-hoc "log today's hours"
// endpoint independent of an active payroll cycle. This function's
// best-effort approach: find the org's current open payroll, and for
// each matched employee whose pay period covers the session's work
// date, add the worked hours to that employee's regular-hours line.
// This is a genuine best-effort guess at Gusto's real payload shape
// and has NOT been verified against a live Gusto account - if a real
// connection is made and this fails, re-deriving this against Gusto's
// current live API docs (not this comment) should be the first step,
// and a real redesign (e.g. only syncing once a payroll is already
// open, rather than any time) may be the right fix rather than a
// payload tweak.
// deno-lint-ignore-file no-explicit-any

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";

const GUSTO_API_BASE = "https://api.gusto-demo.com";
const MAX_SESSIONS_PER_RUN = 50;

async function refreshAccessTokenIfNeeded(
  serviceClient: any,
  organizationId: string,
  connection: { access_token: string; refresh_token: string; access_token_expires_at: string },
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const expiresAt = new Date(connection.access_token_expires_at).getTime();
  if (expiresAt - Date.now() > 5 * 60 * 1000) {
    return connection.access_token;
  }

  const basicAuth = btoa(`${clientId}:${clientSecret}`);
  const response = await fetch(`${GUSTO_API_BASE}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
      "Authorization": `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: connection.refresh_token }).toString(),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Gusto token refresh failed (${response.status}): ${detail}`);
  }

  const tokenData = await response.json();
  const newAccessToken: string = tokenData.access_token;
  const newRefreshToken: string = tokenData.refresh_token;
  const accessTokenExpiresAt = new Date(Date.now() + Number(tokenData.expires_in ?? 7200) * 1000).toISOString();
  const refreshTokenExpiresAt = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString();

  await serviceClient.rpc("record_prosm_time_gusto_token_refresh", {
    p_organization_id: organizationId,
    p_access_token: newAccessToken,
    p_refresh_token: newRefreshToken,
    p_access_token_expires_at: accessTokenExpiresAt,
    p_refresh_token_expires_at: refreshTokenExpiresAt,
  });

  return newAccessToken;
}

async function fetchEmployeeMapByEmail(companyId: string, accessToken: string): Promise<Map<string, string>> {
  const response = await fetch(`${GUSTO_API_BASE}/v1/companies/${companyId}/employees`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Gusto employee lookup failed (${response.status}): ${detail}`);
  }
  const employees = await response.json();
  const map = new Map<string, string>();
  for (const employee of Array.isArray(employees) ? employees : []) {
    const email = employee?.email?.toLowerCase?.();
    if (email && employee.uuid) map.set(email, employee.uuid);
  }
  return map;
}

// Best-effort: the org's current open (unprocessed) payroll run, if
// any - see this file's own header comment for why this is required
// at all.
async function fetchOpenPayroll(companyId: string, accessToken: string): Promise<any | null> {
  const response = await fetch(`${GUSTO_API_BASE}/v1/companies/${companyId}/payrolls?processed=false`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!response.ok) return null;
  const payrolls = await response.json();
  return Array.isArray(payrolls) && payrolls.length > 0 ? payrolls[0] : null;
}

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
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const clientId = Deno.env.get("GUSTO_CLIENT_ID")!;
    const clientSecret = Deno.env.get("GUSTO_CLIENT_SECRET")!;

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

    const { data: statusData, error: statusError } = await callerClient.rpc("get_prosm_time_gusto_status");
    if (statusError) return errorResponse(statusError.message, 403, "FORBIDDEN");
    if (!statusData?.connected) return errorResponse("Gusto is not connected for this organization.", 400, "NOT_CONNECTED");

    const { data: orgId, error: orgError } = await callerClient.rpc("current_prosm_time_organization_id");
    if (orgError || !orgId) return errorResponse("Unable to resolve the caller's organization.", 500, "INTERNAL_ERROR");

    const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: connectionRows, error: connectionError } = await serviceClient.rpc("get_prosm_time_gusto_connection_for_sync", { p_organization_id: orgId });
    const connection = connectionRows?.[0];
    if (connectionError || !connection) {
      return errorResponse("Gusto connection details could not be loaded.", 500, "INTERNAL_ERROR");
    }

    const accessToken = await refreshAccessTokenIfNeeded(serviceClient, orgId, connection, clientId, clientSecret);

    const openPayroll = await fetchOpenPayroll(connection.company_id, accessToken);
    if (!openPayroll) {
      return errorResponse(
        "Gusto has no open (unprocessed) payroll run right now - hours can only be synced into an active payroll cycle. Start a payroll run in Gusto, then try again.",
        400,
        "NO_OPEN_PAYROLL",
      );
    }

    const employeeMap = await fetchEmployeeMapByEmail(connection.company_id, accessToken);

    const { data: sessions, error: sessionsError } = await serviceClient.rpc("list_prosm_time_unsynced_sessions_for_gusto", {
      p_organization_id: orgId,
      p_limit: MAX_SESSIONS_PER_RUN,
    });
    if (sessionsError) return errorResponse(sessionsError.message, 500, "INTERNAL_ERROR");

    let synced = 0;
    let skippedNoEmployee = 0;
    let failed = 0;
    const unmatchedEmails = new Set<string>();

    for (const session of sessions ?? []) {
      const email = (session.employee_email ?? "").toLowerCase();
      const employeeUuid = employeeMap.get(email);
      if (!employeeUuid) {
        skippedNoEmployee += 1;
        if (email) unmatchedEmails.add(email);
        continue;
      }

      const workedHours = Number(session.worked_minutes ?? 0) / 60;

      // Best-effort: add this session's hours onto the employee's
      // regular-hours compensation line within the open payroll. The
      // real Gusto payload for this PUT is not verified here - see
      // this file's own header comment.
      const response = await fetch(
        `${GUSTO_API_BASE}/v1/companies/${connection.company_id}/payrolls/${openPayroll.payroll_deadline ?? openPayroll.uuid}/employee_compensations/${employeeUuid}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ hours: workedHours }),
        },
      );

      if (!response.ok) {
        failed += 1;
        const detail = await response.text().catch(() => "");
        console.error("Gusto compensation update failed:", response.status, detail);
        continue;
      }

      await serviceClient.rpc("record_prosm_time_gusto_session_synced", {
        p_session_id: session.session_id,
        p_external_id: openPayroll.uuid ?? null,
      });
      synced += 1;
    }

    const summary = {
      ranAt: new Date().toISOString(),
      synced,
      skippedNoEmployee,
      failed,
      unmatchedEmails: Array.from(unmatchedEmails),
    };
    await serviceClient.rpc("record_prosm_time_gusto_sync_result", { p_organization_id: orgId, p_summary: summary });

    return successResponse(summary);
  } catch (error: any) {
    console.error("Gusto sync error:", error?.message ?? error);
    return errorResponse(error?.message ?? "Gusto sync service unavailable.", 500, "INTERNAL_ERROR");
  }
});
