// sync-xero-timesheets - PROSM Time. Owner-only. Pushes completed,
// not-yet-synced attendance sessions to the org's connected Xero
// organisation as Payroll Timesheets, matched to a Xero employee by
// email.
//
// HONESTY NOTE (read before relying on this with a real account): the
// Xero Payroll Timesheets API (POST /payroll.xro/2.0/Timesheets)
// genuinely requires a PayrollCalendarID per employee, and typically a
// specific EarningsRateID per timesheet line - this integration reads
// PayrollCalendarID off the employee record returned by GET
// /payroll.xro/2.0/Employees (a real, documented field), but has no
// way to discover or choose the correct EarningsRateID without a real
// connected organisation to inspect (each Xero org configures its own
// Pay Items/Earnings Rates - there is no universal default). The
// payload below sends a best-effort guess and will very likely need
// real adjustment once a genuine Xero developer account and connected
// org exist to test against - this was NOT verified against Xero's
// live API in this pass, only exercised with fake data at the DB
// level. A skipped/failed sync here should not be treated as a bug in
// PROSM Time's own logic until this endpoint's real payload
// requirements are confirmed against Xero's current docs.
//
// Also note Xero Payroll is a UK/AU/NZ-region product - a Xero
// organisation outside those regions will have no Payroll API access
// at all, and this whole integration is inapplicable to it.
// deno-lint-ignore-file no-explicit-any

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";

const XERO_API_BASE = "https://api.xero.com";
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
  const response = await fetch("https://identity.xero.com/connect/token", {
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
    throw new Error(`Xero token refresh failed (${response.status}): ${detail}`);
  }

  const tokenData = await response.json();
  const newAccessToken: string = tokenData.access_token;
  const newRefreshToken: string = tokenData.refresh_token;
  const accessTokenExpiresAt = new Date(Date.now() + Number(tokenData.expires_in ?? 1800) * 1000).toISOString();
  const refreshTokenExpiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();

  await serviceClient.rpc("record_prosm_time_xero_token_refresh", {
    p_organization_id: organizationId,
    p_access_token: newAccessToken,
    p_refresh_token: newRefreshToken,
    p_access_token_expires_at: accessTokenExpiresAt,
    p_refresh_token_expires_at: refreshTokenExpiresAt,
  });

  return newAccessToken;
}

async function fetchEmployeeMapByEmail(tenantId: string, accessToken: string): Promise<Map<string, { employeeId: string; payrollCalendarId: string | null }>> {
  const response = await fetch(`${XERO_API_BASE}/payroll.xro/2.0/Employees`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "Xero-tenant-id": tenantId },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Xero employee lookup failed (${response.status}): ${detail}`);
  }
  const data = await response.json();
  const employees = data?.Employees ?? [];
  const map = new Map<string, { employeeId: string; payrollCalendarId: string | null }>();
  for (const employee of employees) {
    const email = employee?.Email?.toLowerCase?.();
    if (email && employee.EmployeeID) {
      map.set(email, { employeeId: employee.EmployeeID, payrollCalendarId: employee.PayrollCalendarID ?? null });
    }
  }
  return map;
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
    const clientId = Deno.env.get("XERO_CLIENT_ID")!;
    const clientSecret = Deno.env.get("XERO_CLIENT_SECRET")!;

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

    const { data: statusData, error: statusError } = await callerClient.rpc("get_prosm_time_xero_status");
    if (statusError) return errorResponse(statusError.message, 403, "FORBIDDEN");
    if (!statusData?.connected) return errorResponse("Xero is not connected for this organization.", 400, "NOT_CONNECTED");

    const { data: orgId, error: orgError } = await callerClient.rpc("current_prosm_time_organization_id");
    if (orgError || !orgId) return errorResponse("Unable to resolve the caller's organization.", 500, "INTERNAL_ERROR");

    const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: connectionRows, error: connectionError } = await serviceClient.rpc("get_prosm_time_xero_connection_for_sync", { p_organization_id: orgId });
    const connection = connectionRows?.[0];
    if (connectionError || !connection) {
      return errorResponse("Xero connection details could not be loaded.", 500, "INTERNAL_ERROR");
    }

    const accessToken = await refreshAccessTokenIfNeeded(serviceClient, orgId, connection, clientId, clientSecret);
    const employeeMap = await fetchEmployeeMapByEmail(connection.tenant_id, accessToken);

    const { data: sessions, error: sessionsError } = await serviceClient.rpc("list_prosm_time_unsynced_sessions_for_xero", {
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
      const employee = employeeMap.get(email);
      if (!employee || !employee.payrollCalendarId) {
        skippedNoEmployee += 1;
        if (email) unmatchedEmails.add(email);
        continue;
      }

      const workedHours = Number(session.worked_minutes ?? 0) / 60;

      // Best-effort payload - see this file's own header comment.
      // EarningsRateID is left unset (Xero may reject this outright
      // depending on the org's pay item configuration) rather than
      // guessing a value that could post an incorrect earnings type.
      const payload = {
        EmployeeID: employee.employeeId,
        PayrollCalendarID: employee.payrollCalendarId,
        StartDate: session.work_date,
        EndDate: session.work_date,
        Status: "DRAFT",
        TimesheetLines: [
          {
            NumberOfUnits: [workedHours],
          },
        ],
      };

      const response = await fetch(`${XERO_API_BASE}/payroll.xro/2.0/Timesheets`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          "Xero-tenant-id": connection.tenant_id,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        failed += 1;
        const detail = await response.text().catch(() => "");
        console.error("Xero Timesheet create failed:", response.status, detail);
        continue;
      }

      const created = await response.json();
      const timesheetId = created?.Timesheets?.[0]?.TimesheetID ?? null;
      await serviceClient.rpc("record_prosm_time_xero_session_synced", {
        p_session_id: session.session_id,
        p_external_id: timesheetId,
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
    await serviceClient.rpc("record_prosm_time_xero_sync_result", { p_organization_id: orgId, p_summary: summary });

    return successResponse(summary);
  } catch (error: any) {
    console.error("Xero sync error:", error?.message ?? error);
    return errorResponse(error?.message ?? "Xero sync service unavailable.", 500, "INTERNAL_ERROR");
  }
});
