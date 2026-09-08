// gusto-authorize - PROSM Time. Mirrors quickbooks-authorize exactly.
// Mints a short-lived, DB-backed OAuth state via
// start_prosm_time_gusto_connection() (Owner-only, checked inside that
// RPC), then returns the real Gusto consent-screen URL.
//
// Uses Gusto's demo/sandbox domain (api.gusto-demo.com) - matches the
// "a fresh developer signup only has sandbox access" pattern already
// established for QuickBooks. scope note: Gusto's OAuth scopes are
// resource-based (e.g. "companies:read employees:read") - the exact
// current scope catalog should be verified against Gusto's live API
// docs once a real Gusto developer account exists; not verified
// against a live account in this pass.
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
    const clientId = Deno.env.get("GUSTO_CLIENT_ID");
    if (!clientId) {
      return errorResponse("Gusto integration is not configured on this server yet.", 500, "NOT_CONFIGURED");
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

    const { data, error } = await callerClient.rpc("start_prosm_time_gusto_connection");
    if (error || !data?.success) {
      return errorResponse(error?.message ?? "Unable to start the Gusto connection.", 400, "START_FAILED");
    }

    const redirectUri = `${supabaseUrl}/functions/v1/gusto-oauth-callback`;
    const authorizeUrl = new URL("https://api.gusto-demo.com/oauth/authorize");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("scope", "companies:read employees:read");
    authorizeUrl.searchParams.set("state", data.state);

    return successResponse({ authorizeUrl: authorizeUrl.toString() });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Gusto authorize service unavailable.", 500, "INTERNAL_ERROR");
  }
});
