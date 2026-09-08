// gusto-oauth-callback - PROSM Time. verify_jwt=false - mirrors
// quickbooks-oauth-callback/xero-oauth-callback in overall shape.
//
// HONESTY NOTE: Gusto's OAuth token exchange and company-discovery
// shapes are on less certain ground here than QuickBooks' (which this
// session built and verified against real, if limited, knowledge) or
// even Xero's. This implementation's best-effort assumptions:
//   - token endpoint https://api.gusto-demo.com/oauth/token, Basic-auth
//     client credentials, standard authorization_code grant body - same
//     shape as Xero/QuickBooks, but Gusto's docs have in the past also
//     described client_id/client_secret sent as body params instead of
//     Basic auth, so this should be double-checked once a real
//     developer account exists.
//   - the company/account identifier is looked for first directly on
//     the token response (a `company_uuid` field some Gusto API
//     versions return), and if absent, discovered via a follow-up
//     GET /v1/me call and its `companies[0]` entry - this fallback
//     shape is a best-effort guess, not verified against a live Gusto
//     account, and should be the first thing checked if a real
//     connection attempt fails at this step.
// deno-lint-ignore-file no-explicit-any

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" };

function resultPage(title: string, message: string, ok: boolean): Response {
  const color = ok ? "#1b7a4d" : "#b3261e";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1115;color:#e8e8e8;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{max-width:420px;text-align:center;padding:32px}
h1{color:${color};font-size:20px;margin-bottom:12px}
p{color:#a9a9a9;font-size:14px;line-height:1.5}</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
  return new Response(html, { headers: HTML_HEADERS, status: ok ? 200 : 400 });
}

serve(async (request: Request) => {
  try {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const gustoError = url.searchParams.get("error");

    if (gustoError) {
      return resultPage("Connection cancelled", "Gusto reported: " + gustoError + ". You can close this tab and try again from PROSM Time's Settings page.", false);
    }
    if (!code || !state) {
      return resultPage("Invalid callback", "This link is missing required parameters. Close this tab and start the connection again from PROSM Time's Settings page.", false);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const clientId = Deno.env.get("GUSTO_CLIENT_ID")!;
    const clientSecret = Deno.env.get("GUSTO_CLIENT_SECRET")!;

    const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: organizationId, error: stateError } = await serviceClient.rpc("consume_prosm_time_gusto_oauth_state", { p_state: state });
    if (stateError || !organizationId) {
      return resultPage("Link expired", "This connection link has expired or was already used. Close this tab and start again from PROSM Time's Settings page.", false);
    }

    const redirectUri = `${supabaseUrl}/functions/v1/gusto-oauth-callback`;
    const basicAuth = btoa(`${clientId}:${clientSecret}`);

    const tokenResponse = await fetch("https://api.gusto-demo.com/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        "Authorization": `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }).toString(),
    });

    if (!tokenResponse.ok) {
      const detail = await tokenResponse.text().catch(() => "");
      console.error("Gusto token exchange failed:", tokenResponse.status, detail);
      return resultPage("Connection failed", "Gusto did not accept this connection attempt. Close this tab and try again from Settings.", false);
    }

    const tokenData = await tokenResponse.json();
    const accessToken: string = tokenData.access_token;
    const refreshToken: string = tokenData.refresh_token;
    const accessTokenExpiresAt = new Date(Date.now() + Number(tokenData.expires_in ?? 7200) * 1000).toISOString();
    // Gusto refresh tokens are documented as long-lived (no expires-in
    // returned) - a generous fixed assumption, same pattern as Xero's.
    const refreshTokenExpiresAt = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString();

    let companyId: string | null = tokenData.company_uuid ?? null;
    let companyName: string | null = null;
    try {
      const meResponse = await fetch("https://api.gusto-demo.com/v1/me", {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      });
      if (meResponse.ok) {
        const me = await meResponse.json();
        const firstCompany = Array.isArray(me?.companies) ? me.companies[0] : null;
        companyId = companyId ?? firstCompany?.uuid ?? null;
        companyName = firstCompany?.name ?? null;
      }
    } catch (_err) {
      // handled by the companyId null-check below
    }

    if (!companyId) {
      console.error("Gusto company discovery returned no company id.");
      return resultPage("Connection failed", "Gusto accepted the connection but no company was returned. Close this tab and try again from Settings.", false);
    }

    const { error: upsertError } = await serviceClient.rpc("upsert_prosm_time_gusto_connection", {
      p_organization_id: organizationId,
      p_company_id: companyId,
      p_company_name: companyName,
      p_access_token: accessToken,
      p_refresh_token: refreshToken,
      p_access_token_expires_at: accessTokenExpiresAt,
      p_refresh_token_expires_at: refreshTokenExpiresAt,
      p_connected_by: null,
    });

    if (upsertError) {
      console.error("Gusto connection storage failed:", upsertError.message);
      return resultPage("Connection failed", "The connection to Gusto succeeded, but PROSM Time could not save it. Please try again or contact support.", false);
    }

    return resultPage("Gusto connected", `PROSM Time is now connected to ${companyName ?? "your Gusto company"}. You can close this tab and return to PROSM Time's Settings page.`, true);
  } catch (error: any) {
    console.error("Gusto OAuth callback error:", error?.message ?? error);
    return resultPage("Connection failed", "Something went wrong completing the Gusto connection. Close this tab and try again from Settings.", false);
  }
});
