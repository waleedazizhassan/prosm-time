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
import { sendEmail } from "../_shared/emailService.ts";
import { renderLeaveEmails, type LeaveEmailData } from "../_shared/leaveEmail.ts";
import { renderLicenceEmail, type LicenceEmailRow } from "../_shared/licenseEmail.ts";

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

// v2.3.54 (owner 2026-10-26): a leave request and its answer also go by email,
// between the requester and whoever answered - after the push, which they never
// hold up or stop (the email relay is a soft dependency, emailService.ts).
async function sendLeaveEmails(client: any, notificationId: string): Promise<number> {
  let emailed = 0;
  try {
    const { data } = await client.rpc("get_prosm_time_leave_email", { p_notification_id: notificationId });
    if (!data) return 0;
    const leave = data as LeaveEmailData;
    for (const email of renderLeaveEmails(leave)) {
      const result = await sendEmail({ ...email, supabase: client, organizationId: leave.organizationId });
      if (result.sent) emailed += 1;
    }
  } catch {
    // never the push's problem
  }
  return emailed;
}

// Owner 2026-11-03: a licence change is emailed to the owner (from noreply@, owner's choice) with the licence PDF.
async function sendLicenceEmail(client: any, notificationId: string): Promise<number> {
  try {
    const { data } = await client.rpc("get_prosm_time_license_email", { p_notification_id: notificationId });
    if (!data) return 0;
    const row = data as LicenceEmailRow;
    // owner 2026-11-10: the certificate lists what the plan includes
    if (row.plan) {
      const { data: plan } = await client.from("plans").select("feature_flags, max_sites, history_days").eq("key", row.plan).maybeSingle();
      if (plan) row.planInfo = { featureFlags: plan.feature_flags, maxSites: plan.max_sites, historyDays: plan.history_days };
    }
    const email = await renderLicenceEmail(row);
    const result = await sendEmail({ ...email, purpose: "licence_changed", supabase: client, organizationId: row.organizationId });
    return result.sent ? 1 : 0;
  } catch (error) {
    console.error("LICENCE EMAIL FAILED:", error);
    return 0;
  }
}

async function sendNotificationEmails(client: any, notificationId: string): Promise<number> {
  return (await sendLeaveEmails(client, notificationId)) + (await sendLicenceEmail(client, notificationId));
}

serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return errorResponse("Method not allowed.", 405, "METHOD_NOT_ALLOWED");

  try {
    const authorizationHeader = request.headers.get("authorization");
    if (!authorizationHeader) return errorResponse("Missing Authorization header.", 401, "UNAUTHORIZED");
    const { notificationId, warm } = await request.json().catch(() => ({}));
    // Owner 2026-11-12 ("the SOS notification must be very fast"): a ping every minute keeps this function
    // started and Google's access token ready, so a real alert does not wait for either.
    if (warm === true) {
      const raw = Deno.env.get("FCM_SERVICE_ACCOUNT");
      if (raw) await accessToken(JSON.parse(raw) as ServiceAccount).catch(() => undefined);
      return successResponse({ warm: true });
    }
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
    if (!message || devices.length === 0) return successResponse({ sent: 0, emailed: await sendNotificationEmails(client, notificationId) });

    const rawAccount = Deno.env.get("FCM_SERVICE_ACCOUNT");
    if (!rawAccount) return successResponse({ sent: 0, skipped: "FCM_SERVICE_ACCOUNT is not set", emailed: await sendNotificationEmails(client, notificationId) });
    const account = JSON.parse(rawAccount) as ServiceAccount;
    const token = await accessToken(account);

    const urgent = message.priority === "high" || message.type === "sos_alert";
    // v2.3.61 (owner 2026-10-28): clock-in and clock-out reminders ring with the alarm tone (MainActivity's channel)
    // Owner 2026-11-10: a Buzz to a closed app is an ordinary notification (not the alarm tone)
    const reminder = message.type === "clock_in_reminder" || message.type === "clock_out_reminder";
    const gone: string[] = [];
    let sent = 0;
    // Owner 2026-11-11 (notifications late): every phone of the person at once, not one after another
    await Promise.all(devices.map(async ({ token: deviceToken, language }) => {
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
                channel_id: urgent ? "prosm-sos" : reminder ? "prosm-reminders" : "prosm-alerts",
                sound: "default",
                default_sound: true,
                default_vibrate_timings: true,
                notification_priority: urgent ? "PRIORITY_MAX" : "PRIORITY_HIGH",
                visibility: "PUBLIC",
                // v2.3.43 step 19 (item 1): the same small icon and colour as every
                // notification the app shows itself; no picture thumbnail.
                icon: "ic_stat_prosm",
                color: "#1E6FD9",
              },
            },
          },
        }),
      });
      if (response.ok) {
        sent += 1;
        return;
      }
      const failure = await response.json().catch(() => ({}));
      const code = failure?.error?.details?.find((detail: any) => detail.errorCode)?.errorCode ?? failure?.error?.status;
      if (response.status === 404 || code === "UNREGISTERED" || code === "INVALID_ARGUMENT") gone.push(deviceToken);
    }));
    if (gone.length > 0) await client.rpc("forget_prosm_time_push_tokens", { p_tokens: gone });

    return successResponse({ sent, forgotten: gone.length, emailed: await sendNotificationEmails(client, notificationId) });
  } catch (error: any) {
    return errorResponse(error?.message ?? "Push service unavailable.", 500, "INTERNAL_ERROR");
  }
});
