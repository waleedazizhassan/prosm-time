// upsert-allowance-entry - Allowances feature (2026-09-02 plan).
// Forwards the caller's own session to upsert_prosm_time_allowance_
// entry(), which is self-only (no target-user param) and recomputes
// the read-only overtime columns server-side every call - the client
// never supplies those.
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";

serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return errorResponse("Method not allowed.", 405, "METHOD_NOT_ALLOWED");

  try {
    const authorizationHeader = request.headers.get("authorization");
    if (!authorizationHeader) return errorResponse("Missing Authorization header.", 401, "UNAUTHORIZED");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const callerClient = createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: authorizationHeader } },
    });

    const {
      data: { user: authUser },
    } = await callerClient.auth.getUser();
    if (!authUser) return errorResponse("Invalid or expired session.", 401, "UNAUTHORIZED");

    const payload = await request.json().catch(() => ({}));
    const { entryDate, mealAllowance, expatriationAllowance, transportationAllowance, housingAllowance, travelAllowance, otherAllowance, otherAllowanceNote } = payload;
    if (!entryDate || typeof entryDate !== "string") return errorResponse("entryDate is required.", 400, "INVALID_REQUEST");

    const { data, error } = await callerClient.rpc("upsert_prosm_time_allowance_entry", {
      p_entry_date: entryDate,
      p_meal_allowance: typeof mealAllowance === "number" ? mealAllowance : 0,
      p_expatriation_allowance: typeof expatriationAllowance === "number" ? expatriationAllowance : 0,
      p_transportation_allowance: typeof transportationAllowance === "number" ? transportationAllowance : 0,
      p_housing_allowance: typeof housingAllowance === "number" ? housingAllowance : 0,
      p_travel_allowance: typeof travelAllowance === "number" ? travelAllowance : 0,
      p_other_allowance: typeof otherAllowance === "number" ? otherAllowance : 0,
      p_other_allowance_note: otherAllowanceNote ?? null,
    });

    if (error || !data?.success) return errorResponse(error?.message ?? "Unable to save this allowance entry.", 400, "UPSERT_FAILED");
    return successResponse({ entryId: data.entryId });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Allowances service unavailable.", 500, "INTERNAL_ERROR");
  }
});
