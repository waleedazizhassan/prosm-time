// export-sites - PROSM Time's read-only site directory, same
// api_keys/attendance:read auth posture as export-attendance (a site
// NAME is already exposed there - this just makes the full site list
// independently browsable, not derived only from records that happen
// to already have hours logged against them). verify_jwt=false, same
// reasoning as export-attendance's own header comment.
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";
import { clientIdentifier, enforceRateLimits, hashIdentifier } from "../_shared/rateLimit.ts";

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
      { scope: "export_sites_ip", identifier: clientIdentifier(request), limit: 60, windowSeconds: 300, blockSeconds: 900 },
      { scope: "export_sites_key", identifier: await hashIdentifier(rawKey), limit: 60, windowSeconds: 300, blockSeconds: 900 },
    ]);
    if (exportRateLimited) return exportRateLimited;

    const { data: organizationId, error: authError } = await serviceClient.rpc("authenticate_prosm_time_api_key", { p_raw_key: rawKey });
    if (authError || !organizationId) return errorResponse("Invalid or revoked API key.", 401, "UNAUTHORIZED");

    const { data, error } = await serviceClient.rpc("list_prosm_time_sites_export", { p_organization_id: organizationId });
    if (error) return errorResponse(error.message, 500, "INTERNAL_ERROR");

    const records = (data ?? []).map((row: any) => ({
      siteId: row.site_id,
      name: row.name,
      isActive: row.is_active === true,
    }));

    return successResponse({ count: records.length, records });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Site export service unavailable.", 500, "INTERNAL_ERROR");
  }
});
