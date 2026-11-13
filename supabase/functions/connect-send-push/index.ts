// connect-send-push - PROSM Connect (owner 2026-11-13). A new switchboard request wakes its recipients' phones: a call
// rings (a data message the app turns into a full-screen ringing screen, closed and locked included), a message or a
// missed call shows as a notification in the person's language. Called by the switchboard's trigger (pg_net) with
// the service role; its first call (get_prosm_time_connect_push) is granted to service_role alone, so Postgres
// itself refuses anyone else. Nothing is stored: the request already waits in the switchboard.
// deno-lint-ignore-file no-explicit-any

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders, errorResponse, successResponse } from "../_shared/http.ts";

interface ServiceAccount { project_id: string; client_email: string; private_key: string }

const base64Url = (bytes: Uint8Array | string) => {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
let cachedToken: { value: string; expiresAt: number } | null = null;
async function accessToken(account: ServiceAccount): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) return cachedToken.value;
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({ iss: account.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const pem = account.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (char) => char.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`)));
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${base64Url(signature)}` }),
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error(`Firebase sign-in failed: ${data.error ?? response.status}`);
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return cachedToken.value;
}

// the notification's words, in the 9 languages of the app
const T: Record<string, Record<string, string>> = {
  ar: { message: "رسالة جديدة", image: "📷 صورة", camera_photo: "📷 صورة موثّقة", file: "📎 ملف", voice_note: "🎤 رسالة صوتية", push_to_talk: "📻 اضغط واتكلم", site_broadcast: "📢 رسالة للموقع", photo_request: "📷 طلب صورة من الموقع", audio_call: "مكالمة صوتية واردة", video_call: "مكالمة فيديو واردة", meeting_invite: "دعوة لاجتماع", missed: "مكالمة فائتة" },
  en: { message: "New message", image: "📷 Photo", camera_photo: "📷 Verified photo", file: "📎 File", voice_note: "🎤 Voice message", push_to_talk: "📻 Push to talk", site_broadcast: "📢 Message to the site", photo_request: "📷 Photo request from the site", audio_call: "Incoming voice call", video_call: "Incoming video call", meeting_invite: "Meeting invitation", missed: "Missed call" },
  de: { message: "Neue Nachricht", image: "📷 Foto", camera_photo: "📷 Beglaubigtes Foto", file: "📎 Datei", voice_note: "🎤 Sprachnachricht", push_to_talk: "📻 Push-to-Talk", site_broadcast: "📢 Nachricht an den Standort", photo_request: "📷 Fotoanfrage vom Standort", audio_call: "Eingehender Sprachanruf", video_call: "Eingehender Videoanruf", meeting_invite: "Einladung zur Besprechung", missed: "Verpasster Anruf" },
  es: { message: "Nuevo mensaje", image: "📷 Foto", camera_photo: "📷 Foto verificada", file: "📎 Archivo", voice_note: "🎤 Mensaje de voz", push_to_talk: "📻 Pulsar para hablar", site_broadcast: "📢 Mensaje al sitio", photo_request: "📷 Solicitud de foto del sitio", audio_call: "Llamada de voz entrante", video_call: "Videollamada entrante", meeting_invite: "Invitación a reunión", missed: "Llamada perdida" },
  fr: { message: "Nouveau message", image: "📷 Photo", camera_photo: "📷 Photo vérifiée", file: "📎 Fichier", voice_note: "🎤 Message vocal", push_to_talk: "📻 Appuyer pour parler", site_broadcast: "📢 Message au site", photo_request: "📷 Demande de photo du site", audio_call: "Appel vocal entrant", video_call: "Appel vidéo entrant", meeting_invite: "Invitation à une réunion", missed: "Appel manqué" },
  it: { message: "Nuovo messaggio", image: "📷 Foto", camera_photo: "📷 Foto verificata", file: "📎 File", voice_note: "🎤 Messaggio vocale", push_to_talk: "📻 Premi per parlare", site_broadcast: "📢 Messaggio alla sede", photo_request: "📷 Richiesta di foto dalla sede", audio_call: "Chiamata vocale in arrivo", video_call: "Videochiamata in arrivo", meeting_invite: "Invito a una riunione", missed: "Chiamata persa" },
  pt: { message: "Nova mensagem", image: "📷 Foto", camera_photo: "📷 Foto verificada", file: "📎 Ficheiro", voice_note: "🎤 Mensagem de voz", push_to_talk: "📻 Premir para falar", site_broadcast: "📢 Mensagem para o local", photo_request: "📷 Pedido de foto do local", audio_call: "Chamada de voz recebida", video_call: "Videochamada recebida", meeting_invite: "Convite para reunião", missed: "Chamada perdida" },
  ru: { message: "Новое сообщение", image: "📷 Фото", camera_photo: "📷 Заверенное фото", file: "📎 Файл", voice_note: "🎤 Голосовое сообщение", push_to_talk: "📻 Рация", site_broadcast: "📢 Сообщение объекту", photo_request: "📷 Запрос фото с объекта", audio_call: "Входящий голосовой звонок", video_call: "Входящий видеозвонок", meeting_invite: "Приглашение на встречу", missed: "Пропущенный звонок" },
  zh: { message: "新消息", image: "📷 照片", camera_photo: "📷 认证照片", file: "📎 文件", voice_note: "🎤 语音消息", push_to_talk: "📻 一键通话", site_broadcast: "📢 发给地点的消息", photo_request: "📷 地点拍照请求", audio_call: "语音来电", video_call: "视频来电", meeting_invite: "会议邀请", missed: "未接来电" },
};

serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return errorResponse("Method not allowed.", 405, "METHOD_NOT_ALLOWED");
  try {
    const authorization = request.headers.get("authorization");
    if (!authorization) return errorResponse("Missing Authorization header.", 401, "UNAUTHORIZED");
    const { itemId } = await request.json().catch(() => ({}));
    if (!itemId) return errorResponse("itemId is required.", 400, "BAD_REQUEST");
    const client = createClient(Deno.env.get("SUPABASE_URL")!, authorization.replace(/^Bearer\s+/i, ""), {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: authorization } },
    });
    const { data: item, error } = await client.rpc("get_prosm_time_connect_push", { p_item: itemId });
    if (error) return errorResponse("This endpoint requires the service role key.", 401, "UNAUTHORIZED");
    const devices: { token: string; platform: string; language: string }[] = (item?.devices ?? []).filter((d: any) => d.platform === "android");
    if (!item || devices.length === 0) return successResponse({ sent: 0 });
    const raw = Deno.env.get("FCM_SERVICE_ACCOUNT");
    if (!raw) return successResponse({ sent: 0, skipped: "FCM_SERVICE_ACCOUNT is not set" });
    const account = JSON.parse(raw) as ServiceAccount;
    const token = await accessToken(account);
    const ringing = item.type === "audio_call" || item.type === "video_call";
    let sent = 0;
    const gone: string[] = [];
    await Promise.all(devices.map(async (device) => {
      const words = T[device.language] ?? T.ar;
      const title = String(item.fromName ?? "PROSM Connect");
      const body = item.type === "message" && item.body ? String(item.body) : (words[item.type] ?? words.message);
      const data: Record<string, string> = {
        type: ringing ? "connect_call" : "connect_item",
        connectType: String(item.type), itemId: String(item.id), refId: String(item.refId ?? ""),
        conversationId: String(item.conversationId ?? ""), fromId: String(item.fromId ?? ""), title, body,
      };
      // a call: data only, high priority - the app shows the ringing screen itself (closed and locked included)
      const payload = ringing
        ? { token: device.token, data, android: { priority: "HIGH", ttl: "45s" } }
        : {
            token: device.token,
            notification: { title, body },
            data,
            android: {
              priority: "HIGH",
              collapse_key: String(item.conversationId ?? item.id),
              notification: { channel_id: "prosm-alerts", sound: "default", default_sound: true, notification_priority: "PRIORITY_HIGH", visibility: "PRIVATE", icon: "ic_stat_prosm", color: "#1E6FD9", tag: String(item.conversationId ?? item.id) },
            },
          };
      const response = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: payload }),
      });
      if (response.ok) { sent += 1; return; }
      const failure = await response.json().catch(() => ({}));
      const code = failure?.error?.details?.find((d: any) => d.errorCode)?.errorCode ?? failure?.error?.status;
      if (response.status === 404 || code === "UNREGISTERED") gone.push(device.token);
    }));
    if (gone.length > 0) await client.rpc("forget_prosm_time_push_tokens", { p_tokens: gone });
    return successResponse({ sent, forgotten: gone.length });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Push failed.", 500, "INTERNAL_ERROR");
  }
});
