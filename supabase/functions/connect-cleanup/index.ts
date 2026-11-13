// connect-cleanup - PROSM Connect (owner 2026-11-13). The switchboard lets go of a request once it is received, or
// after 7 days; its file in the temporary bucket connect-temp is queued in connect_storage_trash, because deleting
// a row of storage.objects in SQL does not delete the file. This function, called every hour by the cleanup job
// (pg_net, with the service role), removes those files through the Storage API and then their queue entries.
// Only the service role can call it: its first call (prosm_time_connect_take_trash) is granted to service_role
// alone, so Postgres itself refuses anyone else - the same pattern as purge-camera-evidence.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders, errorResponse, successResponse } from "../_shared/http.ts";

const BUCKET = "connect-temp";

serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return errorResponse("Method not allowed.", 405, "METHOD_NOT_ALLOWED");
  try {
    const authorization = request.headers.get("authorization");
    if (!authorization) return errorResponse("Missing Authorization header.", 401, "UNAUTHORIZED");
    const key = authorization.replace(/^Bearer\s+/i, "");
    const client = createClient(Deno.env.get("SUPABASE_URL")!, key, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: authorization } },
    });

    let removed = 0;
    // a few rounds at most per call; what is left waits for the next hour
    for (let round = 0; round < 5; round++) {
      const { data: paths, error } = await client.rpc("prosm_time_connect_take_trash", { p_limit: 500 });
      if (error) return errorResponse("This endpoint requires the service role key.", 401, "UNAUTHORIZED");
      const list = (paths ?? []) as string[];
      if (list.length === 0) break;
      // a file already gone counts as removed; a real failure keeps the whole batch for the next run
      const { error: removeError } = await client.storage.from(BUCKET).remove(list);
      if (removeError && !/not.?found/i.test(removeError.message)) {
        return errorResponse(`Storage: ${removeError.message}`, 502, "STORAGE_FAILED");
      }
      const { data: done } = await client.rpc("prosm_time_connect_trash_done", { p_paths: list });
      removed += Number(done ?? 0);
      if (list.length < 500) break;
    }
    return successResponse({ removed });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Cleanup failed.", 500, "CLEANUP_FAILED");
  }
});
