// PROSM Time - shared Edge Function response/CORS helpers (WP-02
// foundation). Every Edge Function in this repository uses this same
// success/error envelope shape - mirrors PROSM Management's own
// _shared/http.ts convention (docs/CONVENTIONS.md) so nothing here is
// invented from scratch, but this file is its own, independent copy:
// no import crosses from the PROSM Management repository into this one.

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function successResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function errorResponse(message: string, status = 400, code?: string): Response {
  return new Response(JSON.stringify({ success: false, error: { message, code } }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
