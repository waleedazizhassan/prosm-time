// delete-my-account - v2.3.55 (owner 2026-10-27, for Google Play: "the user
// can delete their account from the user menu"). The caller's own session
// asks prepare_prosm_time_self_deletion() whether it may run (never the
// Owner, never while clocked in) and what files are theirs; only then does
// this function act with the service role: it removes those files (photos at
// clock-in/out, leave documents, the profile picture), anonymises the person
// (anonymize_prosm_time_user - their work records stay for the organisation),
// and scrubs and bans the sign-in account. The sign-in account is not
// deleted: that would cascade to the work records the organisation keeps.
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";

const randomSecret = () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

// "https://.../storage/v1/object/public/user-avatars/users/<id>/avatar.png" -> "users/<id>/avatar.png"
const avatarPath = (url: string | null) => {
  if (!url) return null;
  const marker = "/user-avatars/";
  const at = url.indexOf(marker);
  return at >= 0 ? decodeURIComponent(url.slice(at + marker.length).split("?")[0]) : null;
};

serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return errorResponse("Method not allowed.", 405, "METHOD_NOT_ALLOWED");

  try {
    const authorizationHeader = request.headers.get("authorization");
    if (!authorizationHeader) return errorResponse("Missing Authorization header.", 401, "UNAUTHORIZED");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const callerClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: authorizationHeader } },
    });
    const { data: prepared, error: prepareError } = await callerClient.rpc("prepare_prosm_time_self_deletion");
    if (prepareError) return errorResponse(prepareError.message, 400, "NOT_ALLOWED");
    if (!prepared?.authorized) return errorResponse(prepared?.reason === "owner" ? "OWNER ACCOUNT" : "CLOCKED IN", 400, String(prepared?.reason ?? "NOT_ALLOWED").toUpperCase());

    const service = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { autoRefreshToken: false, persistSession: false } });

    // 1. their files
    const evidence: string[] = prepared.evidencePaths ?? [];
    const documents: string[] = prepared.documentPaths ?? [];
    const avatar = avatarPath(prepared.avatarUrl ?? null);
    if (evidence.length > 0) await service.storage.from("camera-evidence").remove(evidence);
    if (documents.length > 0) await service.storage.from("leave-documents").remove(documents);
    if (avatar) await service.storage.from("user-avatars").remove([avatar]);

    // 2. their personal data; the work records stay anonymised
    const { error: anonymiseError } = await service.rpc("anonymize_prosm_time_user", { p_user_id: prepared.userId });
    if (anonymiseError) return errorResponse(anonymiseError.message, 500, "DELETE_FAILED");

    // 3. the sign-in: no email, no password anyone knows, banned, signed out everywhere
    const { error: authError } = await service.auth.admin.updateUserById(prepared.authUserId, {
      email: `deleted-${prepared.userId}@deleted.invalid`,
      password: randomSecret(),
      user_metadata: {},
      ban_duration: "876000h",
    });
    if (authError) return errorResponse(`Personal data removed, but the sign-in could not be closed: ${authError.message}`, 500, "AUTH_CLOSE_FAILED");
    await service.auth.admin.signOut(authorizationHeader.replace(/^Bearer\s+/i, ""), "global").catch(() => undefined);

    return successResponse({ deleted: true });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Account deletion unavailable.", 500, "INTERNAL_ERROR");
  }
});
