// announcement-media (2026-11-09 Media Center): the files of an announcement.
//   upload - whoever may edit the announcement (checked with their own session) adds an image,
//            PDF or Office file (no video: videos are shared as links); it is stored privately in
//            PROSM Platform's media service under this organisation's licence, then recorded here.
//   url    - a recipient of the published announcement (or whoever may edit it) gets a link that
//            works for 5 minutes; nobody else - checked here before Platform is asked.
//   remove - removes a file from a draft, and its stored copy.
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";
import { platformMedia } from "../_shared/platformMedia.ts";

const ALLOWED_TYPES = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif",
  "application/pdf",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/csv", "text/plain",
]);
const MAX_BYTES = 10 * 1024 * 1024;
const refused = (message: string) => errorResponse(message, /NOT ALLOWED|AUTHORITY/.test(message) ? 403 : /NOT FOUND/.test(message) ? 404 : 422, "REFUSED");

serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return errorResponse("Method not allowed.", 405, "METHOD_NOT_ALLOWED");
  const authorization = request.headers.get("authorization");
  if (!authorization) return errorResponse("Missing Authorization header.", 401, "UNAUTHORIZED");
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const caller = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: authorization } },
  });
  const { data: { user } } = await caller.auth.getUser();
  if (!user) return errorResponse("Invalid or expired session.", 401, "UNAUTHORIZED");
  const service = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { autoRefreshToken: false, persistSession: false } });
  const license = async (organizationId: unknown) => {
    if (typeof organizationId !== "string") return null;
    const { data } = await service.rpc("prosm_time_media_license", { p_organization_id: organizationId });
    return typeof data === "string" && data ? data : null;
  };

  const payload = await request.json().catch(() => ({} as any));
  const action = payload?.action;

  if (action === "upload") {
    const { announcementId, fileName, mimeType, fileBase64, title } = payload;
    if (typeof announcementId !== "string" || typeof fileName !== "string" || typeof fileBase64 !== "string" || !fileName.trim()) {
      return errorResponse("announcementId, fileName and fileBase64 are required.", 400, "INVALID_REQUEST");
    }
    if (!ALLOWED_TYPES.has(String(mimeType))) return errorResponse("THIS FILE TYPE IS NOT ACCEPTED", 422, "FILE_TYPE");
    const size = Math.floor(fileBase64.replace(/=+$/, "").length * 3 / 4);
    if (size > MAX_BYTES) return errorResponse("THE FILE IS LARGER THAN 10 MB", 422, "FILE_TOO_LARGE");
    const { data: check, error: checkError } = await caller.rpc("prosm_time_announcement_upload_check", { p_id: announcementId });
    if (checkError || !check?.ok) return refused(checkError?.message ?? "NOT ALLOWED");
    const licenseNumber = await license(check.organizationId);
    if (!licenseNumber) return errorResponse("NO LICENCE FOR THIS ORGANISATION", 422, "NO_LICENSE");
    const name = fileName.trim().slice(0, 200);
    const label = typeof title === "string" && title.trim() ? title.trim().slice(0, 300) : name;
    const stored = await platformMedia("uploadMediaAsset", {
      licenseNumber, fileName: name, mimeType, fileBase64, title: label,
      category: "announcement", private: true, scopeType: "organization", createdByReference: `prosm-time:${check.userId}`,
    });
    if (!stored.ok || !stored.data?.assetId) return errorResponse(stored.error ?? "UPLOAD FAILED", 502, "UPLOAD_FAILED");
    const { data: row, error: attachError } = await service.rpc("prosm_time_announcement_attach_file", {
      p_id: announcementId, p_actor: check.userId, p_asset_id: stored.data.assetId, p_file_name: name, p_mime: mimeType, p_size: size, p_title: label,
    });
    if (attachError) {
      await platformMedia("deleteMediaAsset", { licenseNumber, assetId: stored.data.assetId });
      return refused(attachError.message);
    }
    return successResponse({ id: row?.id });
  }

  if (action === "url") {
    if (typeof payload.attachmentId !== "string") return errorResponse("attachmentId is required.", 400, "INVALID_REQUEST");
    const { data: file, error } = await caller.rpc("prosm_time_announcement_file_for_reader", { p_attachment_id: payload.attachmentId });
    if (error || !file?.assetId) return refused(error?.message ?? "ATTACHMENT NOT FOUND");
    const licenseNumber = await license(file.organizationId);
    if (!licenseNumber) return errorResponse("NO LICENCE FOR THIS ORGANISATION", 422, "NO_LICENSE");
    const signed = await platformMedia("getMediaAssetUrl", { licenseNumber, assetId: file.assetId, expiresIn: 300, download: payload.download === true });
    if (!signed.ok || !signed.data?.url) return errorResponse(signed.error ?? "UNABLE TO OPEN THE FILE", 502, "SIGN_FAILED");
    return successResponse({ url: signed.data.url, fileName: file.fileName, mimeType: file.mimeType, expiresIn: signed.data.expiresIn });
  }

  if (action === "remove") {
    if (typeof payload.attachmentId !== "string") return errorResponse("attachmentId is required.", 400, "INVALID_REQUEST");
    const { data: removed, error } = await caller.rpc("remove_prosm_time_announcement_attachment", { p_attachment_id: payload.attachmentId });
    if (error) return refused(error.message);
    if (removed?.kind === "file" && removed.assetId) {
      const licenseNumber = await license(removed.organizationId);
      const gone = licenseNumber ? await platformMedia("deleteMediaAsset", { licenseNumber, assetId: removed.assetId }) : { ok: false, error: "no licence" };
      if (!gone.ok) console.error("[announcement-media] stored copy not removed", removed.assetId, gone.error);
    }
    return successResponse({ removed: true });
  }

  return errorResponse("Unknown action.", 400, "UNKNOWN_ACTION");
});
