// set-kiosk-pin - WP-18 (§13.1, §35). Self-service: caller sets/
// changes their OWN kiosk PIN. Forwards to set_prosm_time_kiosk_pin().
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
    const { pin } = payload;
    if (!pin || typeof pin !== "string") return errorResponse("pin is required.", 400, "INVALID_REQUEST");

    const { data, error } = await callerClient.rpc("set_prosm_time_kiosk_pin", { p_pin: pin });

    if (error || !data?.success) return errorResponse(error?.message ?? "Unable to set this PIN.", 400, "SET_PIN_FAILED");
    return successResponse({});
  } catch (error: any) {
    return errorResponse(error?.message ?? "Kiosk service unavailable.", 500, "INTERNAL_ERROR");
  }
});
