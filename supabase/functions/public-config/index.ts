// The switches the app reads before anyone signs in (2026-11-01). Public by
// design: it returns only these two booleans, set from the Platform Manager.
// Anything else in platform_settings stays private.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
  "Cache-Control": "public, max-age=300",
};

serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  const config = { showWebLink: true, apkDistributionEnabled: true };
  try {
    const client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data } = await client.from("platform_settings").select("key, value").in("key", ["show_web_link", "apk_distribution_enabled"]);
    for (const row of data ?? []) {
      if (row.key === "show_web_link") config.showWebLink = row.value !== false;
      if (row.key === "apk_distribution_enabled") config.apkDistributionEnabled = row.value !== false;
    }
  } catch {
    // the defaults: the screen never fails on a switch
  }
  return new Response(JSON.stringify(config), { headers });
});
