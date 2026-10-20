import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";

import { requireSupabaseClient } from "../api/supabaseClient";

// Owner 2026-10-18/20: notifications reach the phone even when the app is
// closed (Firebase Cloud Messaging). The Android app registers its token
// for the signed-in person; the server (send-push) does the sending. On
// sign-out the token is removed, so that person's notifications stop
// coming to this phone.
const TOKEN_KEY = "prosm_time_push_token";

// Only in an Android build made with the Firebase file (CI sets the flag when it adds
// google-services.json): without it, calling Firebase would close the app.
export const isPushSupported = () =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android" && import.meta.env.VITE_FIREBASE_CONFIGURED === "true";

/** Where tapping a notification takes the reader. */
export function pushTarget(data: Record<string, unknown> | undefined): string {
  const type = String(data?.type ?? "");
  const entityType = String(data?.entityType ?? "");
  if (type === "sos_alert") return "/emergency-log";
  if (entityType === "leave_requests") return "/leave";
  if (type.startsWith("timesheet")) return "/timesheets";
  if (type === "exception_pending_review" || type === "correction_submitted" || type.startsWith("out_of_zone") || type === "missing_clock_out") return "/manager";
  return "/dashboard";
}

function remember(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable
  }
}

function remembered(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

let started = false;

/** Asks for permission (once), registers this phone and opens the right page when a notification is tapped. */
export async function startPush(open: (path: string) => void): Promise<void> {
  if (!isPushSupported() || started) return;
  started = true;
  try {
    await PushNotifications.createChannel({ id: "prosm-urgent", name: "Urgent (SOS)", importance: 5, sound: "default", vibration: true });
    await PushNotifications.createChannel({ id: "prosm-default", name: "PROSM Time", importance: 3 });
    await PushNotifications.addListener("registration", async ({ value }) => {
      remember(value);
      await requireSupabaseClient().rpc("register_prosm_time_push_device", { p_token: value, p_platform: "android" });
    });
    await PushNotifications.addListener("pushNotificationActionPerformed", ({ notification }) => open(pushTarget(notification.data)));
    let permission = await PushNotifications.checkPermissions();
    if (permission.receive === "prompt" || permission.receive === "prompt-with-rationale") permission = await PushNotifications.requestPermissions();
    if (permission.receive !== "granted") return;
    await PushNotifications.register();
  } catch {
    // no Firebase configuration in this build, or the plugin is unavailable
    started = false;
  }
}

/** Before signing out: this phone stops receiving the person's notifications. */
export async function stopPush(): Promise<void> {
  const token = remembered();
  if (!isPushSupported()) return;
  started = false;
  try {
    await PushNotifications.removeAllListeners();
    if (token) await requireSupabaseClient().rpc("unregister_prosm_time_push_device", { p_token: token });
  } catch {
    // offline: the server forgets the token when Firebase reports it gone or the next person signs in
  }
}
