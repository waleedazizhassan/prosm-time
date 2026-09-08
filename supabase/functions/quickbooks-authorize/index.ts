// quickbooks-authorize - PROSM Time's payroll-integration gap closer
// (the 3rd and final gap from this session's own competitive matrix).
// Mints a short-lived, DB-backed OAuth state via
// start_prosm_time_quickbooks_connection() (which itself re-checks the
// caller is really the org's Owner - this function does not duplicate
// that check, it forwards the caller's own JWT so the RPC's own
// current_prosm_time_user_is_owner() applies), then returns the real
// Intuit consent-screen URL for the frontend to redirect to. The
// client secret never appears here - an OAuth2 authorization request
// only ever needs client_id + redirect_uri, both public-safe.
// deno-lint-ignore-file no-explicit-any

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";

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
    const clientId = Deno.env.get("QUICKBOOKS_CLIENT_ID");
    if (!clientId) {
      return errorResponse("QuickBooks integration is not configured on this server yet.", 500, "NOT_CONFIGURED");
    }

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

    const { data, error } = await callerClient.rpc("start_prosm_time_quickbooks_connection");
    if (error || !data?.success) {
      return errorResponse(error?.message ?? "Unable to start the QuickBooks connection.", 400, "START_FAILED");
    }

    const redirectUri = `${supabaseUrl}/functions/v1/quickbooks-oauth-callback`;
    const authorizeUrl = new URL("https://appcenter.intuit.com/connect/oauth2");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("scope", "com.intuit.quickbooks.accounting");
    authorizeUrl.searchParams.set("state", data.state);

    return successResponse({ authorizeUrl: authorizeUrl.toString() });
  } catch (error: any) {
    return errorResponse(error?.message ?? "QuickBooks authorize service unavailable.", 500, "INTERNAL_ERROR");
  }
});
