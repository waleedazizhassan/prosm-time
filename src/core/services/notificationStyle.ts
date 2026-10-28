import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";

// v2.3.43 step 19 (item 1): every notification the app shows on the phone -
// reminders, the update notice, the leaving-the-site prompt and the pushes
// from the server - carries the same small PROSM icon and colour on the same
// channel. No large icon anywhere (they were mixed before).
export const ALERT_CHANNEL_ID = "prosm-alerts";
export const NOTIFICATION_STYLE = { smallIcon: "ic_stat_prosm", iconColor: "#1E6FD9", channelId: ALERT_CHANNEL_ID } as const;
// v2.3.61 (owner 2026-10-28): the clock-in and clock-out reminders ring with the
// phone's alarm tone - their own channel, made by the Android app at start
// (MainActivity), which the server's reminder pushes use too.
export const REMINDER_STYLE = { ...NOTIFICATION_STYLE, channelId: "prosm-reminders" } as const;

let channelReady: Promise<void> | null = null;

// The push service creates the same channel; a local notification may come
// first (reminders without push), so it is made here too - same settings.
export function ensureAlertChannel(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return Promise.resolve();
  channelReady ??= LocalNotifications.createChannel({ id: ALERT_CHANNEL_ID, name: "PROSM Time", importance: 4, vibration: true, visibility: 1 }).catch((error) => {
    channelReady = null;
    console.warn("[notifications] could not create the alerts channel", error);
  });
  return channelReady;
}

// Android 14+ refuses exact alarms unless the person allows them; the plugin
// then schedules an inexact one (it may arrive a few minutes late). null when
// unknown or not applicable.
export async function exactAlarmsAllowed(): Promise<boolean | null> {
  if (Capacitor.getPlatform() !== "android") return null;
  try {
    const status = await LocalNotifications.checkExactNotificationSetting();
    return status.exact_alarm === "granted";
  } catch (error) {
    console.warn("[notifications] could not read the exact-alarm setting", error);
    return null;
  }
}

export async function openExactAlarmSetting(): Promise<boolean | null> {
  try {
    const status = await LocalNotifications.changeExactNotificationSetting();
    return status.exact_alarm === "granted";
  } catch (error) {
    console.warn("[notifications] could not open the exact-alarm setting", error);
    return null;
  }
}
