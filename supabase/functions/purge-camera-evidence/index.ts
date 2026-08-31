// purge-camera-evidence - PROSM Time Implementation Master File V3.0,
// WP-08 (§16: "subject to retention/deletion policy"). The real,
// callable half of the retention-policy foundation:
// list_expired_prosm_time_camera_evidence() (a migration-level RPC)
// identifies what is past its retention_expires_at; this function
// deletes both the storage object and the metadata row for each one,
// and writes an audit_logs entry. No automatic schedule is wired up
// this pass (a real pg_cron trigger calling this function is future
// scope, deliberately not built here) - this is invoked manually or
// by whatever scheduler is set up later, always with the service role
// key, never a session token.
//
// verify_jwt=false (config.toml) because this must never be reachable
// by an ordinary authenticated org member at all. Authorization is not
// a manual string comparison against SUPABASE_SERVICE_ROLE_KEY (Supabase
// projects can carry both a legacy JWT-format service_role key and a
// newer sb_secret_* key simultaneously, and which one this runtime's
// own env var resolves to is not something to hardcode against) -
// instead, the client is built from whatever bearer token the caller
// supplied, and the very first real operation
// (list_expired_prosm_time_camera_evidence, EXECUTE granted to
// service_role only in the migration) is the actual authorization
// check: Postgres itself rejects any caller without genuine
// service-role privilege, the same way every other service_role-only
// RPC in this codebase is already protected.
// deno-lint-ignore-file no-explicit-any

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";

const BUCKET = "camera-evidence";

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
    const suppliedKey = authorizationHeader.replace(/^Bearer\s+/i, "");
    const callerClient = createClient(supabaseUrl, suppliedKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: authorizationHeader } },
    });

    const { data: expired, error: listError } = await callerClient.rpc("list_expired_prosm_time_camera_evidence");
    if (listError) {
      return errorResponse("This endpoint requires the service role key.", 401, "UNAUTHORIZED");
    }

    const rows = (expired ?? []) as { id: string; storage_path: string }[];
    let deletedCount = 0;
    const failures: { id: string; message: string }[] = [];

    for (const row of rows) {
      const { error: storageError } = await callerClient.storage.from(BUCKET).remove([row.storage_path]);
      if (storageError) {
        failures.push({ id: row.id, message: storageError.message });
        continue;
      }

      const { error: recordError } = await callerClient.rpc("delete_prosm_time_camera_evidence_record", { p_evidence_id: row.id });
      if (recordError) {
        failures.push({ id: row.id, message: recordError.message });
        continue;
      }

      deletedCount += 1;
    }

    return successResponse({ deletedCount, failedCount: failures.length, failures });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Camera evidence purge service unavailable.", 500, "INTERNAL_ERROR");
  }
});
