// quickbooks-oauth-callback - PROSM Time. verify_jwt=false because
// Intuit's browser redirect lands here with NO Supabase session at
// all - the ?state= value (minted by quickbooks-authorize, consumed
// exactly once via consume_prosm_time_quickbooks_oauth_state) is what
// recovers which organization initiated this connection, doubling as
// the OAuth2 CSRF-prevention mechanism.
//
// Deliberately does NOT try to redirect back into the app - this repo
// has no fixed, known public frontend URL (dev runs on localhost with
// whatever port Vite picks; there is no hosted production domain to
// redirect to, per prosm_net_frontend_deployment_disconnected in
// memory). Returns a small standalone HTML page instead; the user
// closes the tab and returns to Settings themselves, which the
// QuickBooks card's own "Refresh status" covers.
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
    const realmId = url.searchParams.get("realmId");
    const intuitError = url.searchParams.get("error");

    if (intuitError) {
      return resultPage("Connection cancelled", "QuickBooks reported: " + intuitError + ". You can close this tab and try again from PROSM Time's Settings page.", false);
    }
    if (!code || !state || !realmId) {
      return resultPage("Invalid callback", "This link is missing required parameters. Close this tab and start the connection again from PROSM Time's Settings page.", false);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const clientId = Deno.env.get("QUICKBOOKS_CLIENT_ID")!;
    const clientSecret = Deno.env.get("QUICKBOOKS_CLIENT_SECRET")!;

    const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: organizationId, error: stateError } = await serviceClient.rpc("consume_prosm_time_quickbooks_oauth_state", { p_state: state });
    if (stateError || !organizationId) {
      return resultPage("Link expired", "This connection link has expired or was already used. Close this tab and start again from PROSM Time's Settings page.", false);
    }

    const redirectUri = `${supabaseUrl}/functions/v1/quickbooks-oauth-callback`;
    const basicAuth = btoa(`${clientId}:${clientSecret}`);

    const tokenResponse = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
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
      console.error("QuickBooks token exchange failed:", tokenResponse.status, detail);
      return resultPage("Connection failed", "QuickBooks did not accept this connection attempt. Close this tab and try again from Settings.", false);
    }

    const tokenData = await tokenResponse.json();
    const accessToken: string = tokenData.access_token;
    const refreshToken: string = tokenData.refresh_token;
    const accessTokenExpiresAt = new Date(Date.now() + (Number(tokenData.expires_x_sec ?? tokenData.expires_in ?? 3600) * 1000)).toISOString();
    const refreshTokenExpiresAt = new Date(Date.now() + (Number(tokenData.x_refresh_token_expires_in ?? 8640000) * 1000)).toISOString();

    let companyName: string | null = null;
    try {
      const companyResponse = await fetch(`https://sandbox-quickbooks.api.intuit.com/v3/company/${realmId}/companyinfo/${realmId}`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      });
      if (companyResponse.ok) {
        const companyData = await companyResponse.json();
        companyName = companyData?.CompanyInfo?.CompanyName ?? null;
      }
    } catch (_err) {
      // Non-fatal - the connection itself already succeeded.
    }

    const { error: upsertError } = await serviceClient.rpc("upsert_prosm_time_quickbooks_connection", {
      p_organization_id: organizationId,
      p_realm_id: realmId,
      p_company_name: companyName,
      p_access_token: accessToken,
      p_refresh_token: refreshToken,
      p_access_token_expires_at: accessTokenExpiresAt,
      p_refresh_token_expires_at: refreshTokenExpiresAt,
      p_connected_by: null,
    });

    if (upsertError) {
      console.error("QuickBooks connection storage failed:", upsertError.message);
      return resultPage("Connection failed", "The connection to QuickBooks succeeded, but PROSM Time could not save it. Please try again or contact support.", false);
    }

    return resultPage("QuickBooks connected", `PROSM Time is now connected to ${companyName ?? "your QuickBooks company"}. You can close this tab and return to PROSM Time's Settings page.`, true);
  } catch (error: any) {
    console.error("QuickBooks OAuth callback error:", error?.message ?? error);
    return resultPage("Connection failed", "Something went wrong completing the QuickBooks connection. Close this tab and try again from Settings.", false);
  }
});
