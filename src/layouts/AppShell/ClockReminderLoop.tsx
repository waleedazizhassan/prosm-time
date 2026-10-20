import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";

import { useAuth } from "../../core/context/AuthContext";
import AttendanceRepository from "../../core/repositories/AttendanceRepository";
import ShiftRepository from "../../core/repositories/ShiftRepository";
import SiteRepository from "../../core/repositories/SiteRepository";
import { nextClockReminder } from "../../core/services/clockReminders";

const CHECK_INTERVAL_MS = 2 * 60 * 1000;
const REMINDER_ID = 7001;

// Owner 2026-10-18 ("a clear reminder to clock in and out"): on the phone
// app the device itself keeps one reminder scheduled - to clock out shortly
// after the shift's end while clocked in, or to clock in just before the
// next scheduled shift - so it arrives even with the app closed and without
// a connection. Checked every two minutes and after every change; a failed
// check (no connection) leaves the last reminder in place. Mounted once in
// the app shell, like PresenceTrackingLoop. Not for the Owner, who doesn't
// clock in.
export default function ClockReminderLoop() {
  const { t } = useTranslation("common");
  const { profile } = useAuth();
  const profileId = profile?.id;
  const enabled = Capacitor.isNativePlatform() && Boolean(profileId) && !profile?.isOwner;
  const scheduledKey = useRef<string | null>(null);
  const siteEndTimes = useRef<Record<string, string | null>>({});

  useEffect(() => {
    if (!enabled || !profileId) return;
    let cancelled = false;

    const check = async () => {
      const [sessionResult, shiftsResult] = await Promise.all([AttendanceRepository.getCurrentSession(profileId), ShiftRepository.listMine(profileId)]);
      if (cancelled || !sessionResult.success || !shiftsResult.success) return;
      const session = sessionResult.data ?? null;
      if (session?.siteId && !(session.siteId in siteEndTimes.current)) {
        const site = await SiteRepository.getSite(session.siteId);
        siteEndTimes.current[session.siteId] = site.success ? site.data?.shiftEndTime ?? null : null;
      }
      const reminder = nextClockReminder(new Date(), session ? { siteId: session.siteId || null, clockInAt: session.clockInAt } : null, shiftsResult.data ?? [], siteEndTimes.current);
      const key = reminder ? `${reminder.kind}@${reminder.at.toISOString()}` : "none";
      if (cancelled || key === scheduledKey.current) return;

      try {
        await LocalNotifications.cancel({ notifications: [{ id: REMINDER_ID }] });
        if (reminder) {
          const permission = await LocalNotifications.checkPermissions();
          const display = permission.display === "granted" ? "granted" : (await LocalNotifications.requestPermissions()).display;
          if (display !== "granted") return;
          await LocalNotifications.schedule({
            notifications: [
              {
                id: REMINDER_ID,
                title: t(`reminders.${reminder.kind}.title`),
                body: t(`reminders.${reminder.kind}.body`, { time: reminder.time, site: reminder.siteName ?? "" }),
                schedule: { at: reminder.at, allowWhileIdle: true },
              },
            ],
          });
        }
        scheduledKey.current = key;
      } catch {
        // no notification permission or plugin - nothing to remind with
      }
    };

    void check();
    const interval = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [enabled, profileId, t]);

  return null;
}
