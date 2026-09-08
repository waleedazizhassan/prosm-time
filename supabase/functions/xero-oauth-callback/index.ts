// xero-oauth-callback - PROSM Time. verify_jwt=false - mirrors
// quickbooks-oauth-callback exactly (see that file's own header
// comment for why no redirect back into the SPA is attempted).
//
// Unlike QuickBooks (whose realmId arrives as a query param on the
// redirect itself), Xero's tenantId is NOT part of the redirect or the
// token response at all - after exchanging the code for tokens, this
// function makes a SEPARATE call to GET https://api.xero.com/connections
// (Bearer <access_token>) to discover it, taking the first connection
// returned. A real Xero app could in principle be authorized for
// multiple tenants in one consent - this implementation only stores
// the first, matching the "one org, one connected company" shape every
// other provider here already uses.
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
    const xeroError = url.searchParams.get("error");

    if (xeroError) {
      return resultPage("Connection cancelled", "Xero reported: " + xeroError + ". You can close this tab and try again from PROSM Time's Settings page.", false);
    }
    if (!code || !state) {
      return resultPage("Invalid callback", "This link is missing required parameters. Close this tab and start the connection again from PROSM Time's Settings page.", false);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const clientId = Deno.env.get("XERO_CLIENT_ID")!;
    const clientSecret = Deno.env.get("XERO_CLIENT_SECRET")!;

    const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: organizationId, error: stateError } = await serviceClient.rpc("consume_prosm_time_xero_oauth_state", { p_state: state });
    if (stateError || !organizationId) {
      return resultPage("Link expired", "This connection link has expired or was already used. Close this tab and start again from PROSM Time's Settings page.", false);
    }

    const redirectUri = `${supabaseUrl}/functions/v1/xero-oauth-callback`;
    const basicAuth = btoa(`${clientId}:${clientSecret}`);

    const tokenResponse = await fetch("https://identity.xero.com/connect/token", {
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
      console.error("Xero token exchange failed:", tokenResponse.status, detail);
      return resultPage("Connection failed", "Xero did not accept this connection attempt. Close this tab and try again from Settings.", false);
    }

    const tokenData = await tokenResponse.json();
    const accessToken: string = tokenData.access_token;
    const refreshToken: string = tokenData.refresh_token;
    const accessTokenExpiresAt = new Date(Date.now() + Number(tokenData.expires_in ?? 1800) * 1000).toISOString();
    // Xero refresh tokens are valid 60 days and rotate on every use -
    // there is no expires-in field for the refresh token itself in the
    // token response, so this is a fixed, documented assumption rather
    // than a value read from the response (unlike access_token_expires_at).
    const refreshTokenExpiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();

    let tenantId: string | null = null;
    let companyName: string | null = null;
    try {
      const connectionsResponse = await fetch("https://api.xero.com/connections", {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      });
      if (connectionsResponse.ok) {
        const connections = await connectionsResponse.json();
        const first = Array.isArray(connections) ? connections[0] : null;
        tenantId = first?.tenantId ?? null;
        companyName = first?.tenantName ?? null;
      }
    } catch (_err) {
      // handled by the tenantId null-check below
    }

    if (!tenantId) {
      console.error("Xero connections discovery returned no tenant.");
      return resultPage("Connection failed", "Xero accepted the connection but no company (tenant) was returned. Close this tab and try again from Settings.", false);
    }

    const { error: upsertError } = await serviceClient.rpc("upsert_prosm_time_xero_connection", {
      p_organization_id: organizationId,
      p_tenant_id: tenantId,
      p_company_name: companyName,
      p_access_token: accessToken,
      p_refresh_token: refreshToken,
      p_access_token_expires_at: accessTokenExpiresAt,
      p_refresh_token_expires_at: refreshTokenExpiresAt,
      p_connected_by: null,
    });

    if (upsertError) {
      console.error("Xero connection storage failed:", upsertError.message);
      return resultPage("Connection failed", "The connection to Xero succeeded, but PROSM Time could not save it. Please try again or contact support.", false);
    }

    return resultPage("Xero connected", `PROSM Time is now connected to ${companyName ?? "your Xero organisation"}. You can close this tab and return to PROSM Time's Settings page.`, true);
  } catch (error: any) {
    console.error("Xero OAuth callback error:", error?.message ?? error);
    return resultPage("Connection failed", "Something went wrong completing the Xero connection. Close this tab and try again from Settings.", false);
  }
});
