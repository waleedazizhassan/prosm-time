// send-push - owner 2026-10-18/20: notifications reach people's phones
// even when the app is closed. Called in the background by the
// notifications insert trigger (20261020100000) with the service role key;
// sends the notification through Firebase Cloud Messaging (HTTP v1) to
// every phone the person registered, and forgets tokens Firebase reports
// as gone. verify_jwt=false like the other maintenance endpoints: the
// service-role-only RPC below is the real authorization check.
//
// Secret FCM_SERVICE_ACCOUNT: the Firebase project's service account JSON
// (Project settings > Service accounts > Generate new private key).
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders, successResponse, errorResponse } from "../_shared/http.ts";
import { localizePush } from "../_shared/localizePush.ts";

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

const base64Url = (bytes: Uint8Array | string) => {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

let cachedToken: { value: string; expiresAt: number } | null = null;

// An OAuth access token for FCM, from the service account (a signed JWT, RS256).
async function accessToken(account: ServiceAccount): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) return cachedToken.value;
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const pem = account.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (char) => char.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`)));
  const assertion = `${header}.${claims}.${base64Url(signature)}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error(`Firebase sign-in failed: ${data.error ?? response.status}`);
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return cachedToken.value;
}

serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return errorResponse("Method not allowed.", 405, "METHOD_NOT_ALLOWED");

  try {
    const authorizationHeader = request.headers.get("authorization");
    if (!authorizationHeader) return errorResponse("Missing Authorization header.", 401, "UNAUTHORIZED");
    const { notificationId } = await request.json().catch(() => ({}));
    if (!notificationId) return errorResponse("notificationId is required.", 400, "BAD_REQUEST");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const suppliedKey = authorizationHeader.replace(/^Bearer\s+/i, "");
    const client = createClient(supabaseUrl, suppliedKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: authorizationHeader } },
    });

    // Service role only: anyone else gets "permission denied" here.
    const { data: message, error } = await client.rpc("get_prosm_time_push_message", { p_notification_id: notificationId });
    if (error) return errorResponse("This endpoint requires the service role key.", 401, "UNAUTHORIZED");
    const devices: { token: string; language: string }[] = message?.devices ?? [];
    if (!message || devices.length === 0) return successResponse({ sent: 0 });

    const rawAccount = Deno.env.get("FCM_SERVICE_ACCOUNT");
    if (!rawAccount) return successResponse({ sent: 0, skipped: "FCM_SERVICE_ACCOUNT is not set" });
    const account = JSON.parse(rawAccount) as ServiceAccount;
    const token = await accessToken(account);

    const urgent = message.priority === "high" || message.type === "sos_alert";
    const gone: string[] = [];
    let sent = 0;
    for (const { token: deviceToken, language } of devices) {
      // In the phone's language, with the in-app bell's own texts.
      const text = localizePush(String(message.type ?? ""), message.data ?? {}, language, { title: message.title, body: message.body });
      const response = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            token: deviceToken,
            notification: { title: text.title, body: text.body },
            data: {
              notificationId: String(message.notificationId),
              type: String(message.type ?? ""),
              entityType: String(message.entityType ?? ""),
              entityId: String(message.entityId ?? ""),
              // v2.3.43: which reader a shared type is for (e.g. "manager"), for the tap's destination.
              kind: String((message.data as Record<string, unknown> | undefined)?.kind ?? ""),
            },
            // Owner 2026-10-20 ("no sound"): channels with sound and vibration
            // (the first ones were created silent and Android keeps a channel's
            // settings, so these are new). HIGH so it shows at once, on screen.
            android: {
              priority: "HIGH",
              notification: {
                channel_id: urgent ? "prosm-sos" : "prosm-alerts",
                sound: "default",
                default_sound: true,
                default_vibrate_timings: true,
                notification_priority: urgent ? "PRIORITY_MAX" : "PRIORITY_HIGH",
                visibility: "PUBLIC",
                icon: "ic_stat_prosm",
                color: "#1E6FD9",
                // Owner 2026-10-20: the app's full-colour icon beside the notification
                // (Android shows the image as a thumbnail next to the text).
                image: "https://time.prosm.net/prosm-logo.png",
              },
            },
          },
        }),
      });
      if (response.ok) {
        sent += 1;
        continue;
      }
      const failure = await response.json().catch(() => ({}));
      const code = failure?.error?.details?.find((detail: any) => detail.errorCode)?.errorCode ?? failure?.error?.status;
      if (response.status === 404 || code === "UNREGISTERED" || code === "INVALID_ARGUMENT") gone.push(deviceToken);
    }
    if (gone.length > 0) await client.rpc("forget_prosm_time_push_tokens", { p_tokens: gone });

    return successResponse({ sent, forgotten: gone.length });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Push service unavailable.", 500, "INTERNAL_ERROR");
  }
});
