// sync-quickbooks-time-activity - PROSM Time. Owner-only. Pushes
// completed, not-yet-synced attendance sessions to the org's connected
// QuickBooks Online company as TimeActivity entries, matched to a
// QuickBooks Employee by email (the same email-matching convention
// already established for the PROSM Projects bridge). Uses the
// Duration form of TimeActivity (Hours/Minutes) rather than
// StartTime/EndTime so the worked-minutes figure already excludes
// break time - the same figure this codebase already treats as
// authoritative elsewhere (list_prosm_time_attendance_export).
//
// Refreshes the access token first whenever it's expired or expiring
// soon - QuickBooks issues a NEW refresh token on every refresh call
// (rotating, single-use), so the new one is persisted immediately or
// every later sync would fail with an already-invalidated token.
// deno-lint-ignore-file no-explicit-any

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";

const QBO_API_BASE = "https://sandbox-quickbooks.api.intuit.com";
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
  const response = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
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
    throw new Error(`QuickBooks token refresh failed (${response.status}): ${detail}`);
  }

  const tokenData = await response.json();
  const newAccessToken: string = tokenData.access_token;
  const newRefreshToken: string = tokenData.refresh_token;
  const accessTokenExpiresAt = new Date(Date.now() + Number(tokenData.expires_in ?? 3600) * 1000).toISOString();
  const refreshTokenExpiresAt = new Date(Date.now() + Number(tokenData.x_refresh_token_expires_in ?? 8640000) * 1000).toISOString();

  await serviceClient.rpc("record_prosm_time_quickbooks_token_refresh", {
    p_organization_id: organizationId,
    p_access_token: newAccessToken,
    p_refresh_token: newRefreshToken,
    p_access_token_expires_at: accessTokenExpiresAt,
    p_refresh_token_expires_at: refreshTokenExpiresAt,
  });

  return newAccessToken;
}

async function fetchEmployeeMapByEmail(realmId: string, accessToken: string): Promise<Map<string, string>> {
  const query = encodeURIComponent("select Id, PrimaryEmailAddr from Employee where Active = true maxresults 1000");
  const response = await fetch(`${QBO_API_BASE}/v3/company/${realmId}/query?query=${query}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`QuickBooks employee lookup failed (${response.status}): ${detail}`);
  }
  const data = await response.json();
  const employees = data?.QueryResponse?.Employee ?? [];
  const map = new Map<string, string>();
  for (const employee of employees) {
    const email = employee?.PrimaryEmailAddr?.Address?.toLowerCase?.();
    if (email && employee.Id) map.set(email, employee.Id);
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
    const clientId = Deno.env.get("QUICKBOOKS_CLIENT_ID")!;
    const clientSecret = Deno.env.get("QUICKBOOKS_CLIENT_SECRET")!;

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

    // get_prosm_time_quickbooks_status() itself enforces the
    // Owner-only check via current_prosm_time_user_is_owner() - reused
    // here rather than duplicating that check, and it also confirms a
    // connection actually exists before any QuickBooks call is made.
    const { data: statusData, error: statusError } = await callerClient.rpc("get_prosm_time_quickbooks_status");
    if (statusError) return errorResponse(statusError.message, 403, "FORBIDDEN");
    if (!statusData?.connected) return errorResponse("QuickBooks is not connected for this organization.", 400, "NOT_CONNECTED");

    const { data: orgId, error: orgError } = await callerClient.rpc("current_prosm_time_organization_id");
    if (orgError || !orgId) return errorResponse("Unable to resolve the caller's organization.", 500, "INTERNAL_ERROR");

    const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: connectionRows, error: connectionError } = await serviceClient.rpc("get_prosm_time_quickbooks_connection_for_sync", { p_organization_id: orgId });
    const connection = connectionRows?.[0];
    if (connectionError || !connection) {
      return errorResponse("QuickBooks connection details could not be loaded.", 500, "INTERNAL_ERROR");
    }

    const accessToken = await refreshAccessTokenIfNeeded(serviceClient, orgId, connection, clientId, clientSecret);
    const employeeMap = await fetchEmployeeMapByEmail(connection.realm_id, accessToken);

    const { data: sessions, error: sessionsError } = await serviceClient.rpc("list_prosm_time_unsynced_sessions_for_quickbooks", {
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
      const employeeId = employeeMap.get(email);
      if (!employeeId) {
        skippedNoEmployee += 1;
        if (email) unmatchedEmails.add(email);
        continue;
      }

      const workedMinutes = Number(session.worked_minutes ?? 0);
      const hours = Math.floor(workedMinutes / 60);
      const minutes = Math.round(workedMinutes % 60);

      const payload = {
        TxnDate: session.work_date,
        NameOf: "Employee",
        EmployeeRef: { value: employeeId },
        Hours: hours,
        Minutes: minutes,
        Description: `Synced from PROSM Time - ${session.employee_name ?? ""}`.trim(),
      };

      const response = await fetch(`${QBO_API_BASE}/v3/company/${connection.realm_id}/timeactivity`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        failed += 1;
        const detail = await response.text().catch(() => "");
        console.error("QuickBooks TimeActivity create failed:", response.status, detail);
        continue;
      }

      const created = await response.json();
      const timeActivityId = created?.TimeActivity?.Id ?? null;
      await serviceClient.rpc("record_prosm_time_quickbooks_session_synced", {
        p_session_id: session.session_id,
        p_time_activity_id: timeActivityId,
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
    await serviceClient.rpc("record_prosm_time_quickbooks_sync_result", { p_organization_id: orgId, p_summary: summary });

    return successResponse(summary);
  } catch (error: any) {
    console.error("QuickBooks sync error:", error?.message ?? error);
    return errorResponse(error?.message ?? "QuickBooks sync service unavailable.", 500, "INTERNAL_ERROR");
  }
});
