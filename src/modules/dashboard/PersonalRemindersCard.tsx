import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { ensureAlertChannel, exactAlarmsAllowed, NOTIFICATION_STYLE, openExactAlarmSetting } from "../../core/services/notificationStyle";

import { useAuth } from "../../core/context/AuthContext";
import { ALL_REMINDER_IDS, loadReminders, remindersToSchedule, storeReminders, type PersonalReminders } from "../../core/services/personalReminders";
import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import Input from "../../components/common/Input";
import Toggle from "../../components/common/Toggle";
import HintText from "../../components/common/HintText";
import ErrorText from "../../components/common/ErrorText";
import DateRange from "../../components/common/DateRange";

const DAYS = [0, 1, 2, 3, 4, 5, 6];

// Owner 2026-10-21 ("where is the reminder the employee can set to remember to
// clock in and out?"): each person sets their own reminder times and days; the
// phone repeats them every week, even with the app closed. On the web the
// card says the reminders live in the phone app.
export default function PersonalRemindersCard() {
  const { t, i18n } = useTranslation("dashboard");
  const { profile } = useAuth();
  const userId = profile?.id ?? "";
  const onPhone = Capacitor.isNativePlatform();
  const [settings, setSettings] = useState<PersonalReminders>(() => loadReminders(userId));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  // v2.3.43 step 19 (item 12): Android 14+ may refuse exact alarms; the reminder then comes a few minutes late.
  const [exactAllowed, setExactAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    if (onPhone && settings.enabled) void exactAlarmsAllowed().then(setExactAllowed);
  }, [onPhone, settings.enabled]);

  useEffect(() => {
    if (userId) setSettings(loadReminders(userId));
  }, [userId]);

  const weekdayName = (day: number) => new Date(2026, 0, 4 + day).toLocaleDateString(i18n.language, { weekday: "short" }); // 4 Jan 2026 is a Sunday

  const toggleDay = (day: number) =>
    setSettings((current) => ({ ...current, days: current.days.includes(day) ? current.days.filter((d) => d !== day) : [...current.days, day] }));

  const save = async () => {
    setSaving(true);
    setMessage("");
    setError("");
    try {
      if (settings.enabled) {
        const permission = await LocalNotifications.checkPermissions();
        const display = permission.display === "granted" ? "granted" : (await LocalNotifications.requestPermissions()).display;
        if (display !== "granted") {
          setError(t("reminders.permissionNeeded"));
          setSaving(false);
          return;
        }
      }
      await LocalNotifications.cancel({ notifications: ALL_REMINDER_IDS.map((id) => ({ id })) });
      const scheduled = remindersToSchedule(settings);
      if (scheduled.length > 0) {
        await ensureAlertChannel();
        await LocalNotifications.schedule({
          notifications: scheduled.map((reminder) => ({
            id: reminder.id,
            title: t(reminder.kind === "clockIn" ? "reminders.clockInTitle" : "reminders.clockOutTitle"),
            body: t(reminder.kind === "clockIn" ? "reminders.clockInBody" : "reminders.clockOutBody"),
            ...NOTIFICATION_STYLE,
            schedule: { on: { weekday: reminder.weekday, hour: reminder.hour, minute: reminder.minute }, allowWhileIdle: true },
          })),
        });
      }
      storeReminders(userId, settings);
      setMessage(settings.enabled ? t("reminders.saved", { count: settings.days.length }) : t("reminders.off"));
    } catch (error) {
      console.warn("[reminders] could not save the reminders", error);
      setError(t("reminders.saveError"));
    }
    setSaving(false);
  };

  if (!profile || profile.isOwner) return null;

  return (
    <Card title={t("reminders.title")} subtitle={onPhone ? t("reminders.hint") : t("reminders.phoneOnly")}>
      {onPhone ? (
        <>
          <label style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginBottom: "var(--space-4)", fontSize: "var(--font-sm)", fontWeight: 600 }}>
            <Toggle checked={settings.enabled} onChange={(enabled) => setSettings((current) => ({ ...current, enabled }))} label={t("reminders.enable")} />
            {t("reminders.enable")}
          </label>
          {settings.enabled ? (
            <>
              <DateRange>
                <Input label={t("reminders.clockInAt")} name="reminderClockIn" type="time" value={settings.clockIn} onChange={(event) => setSettings((current) => ({ ...current, clockIn: event.target.value }))} />
                <Input label={t("reminders.clockOutAt")} name="reminderClockOut" type="time" value={settings.clockOut} onChange={(event) => setSettings((current) => ({ ...current, clockOut: event.target.value }))} />
              </DateRange>
              <HintText small>{t("reminders.daysLabel")}</HintText>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", marginBottom: "var(--space-4)" }}>
                {DAYS.map((day) => {
                  const on = settings.days.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleDay(day)}
                      style={{
                        minWidth: 44,
                        minHeight: 36,
                        padding: "0 var(--space-3)",
                        borderRadius: "var(--radius-full)",
                        border: `1px solid ${on ? "transparent" : "var(--border-medium)"}`,
                        background: on ? "var(--brand-gradient-action)" : "var(--surface-raised)",
                        color: on ? "var(--brand-on-primary)" : "var(--text-primary)",
                        font: "inherit",
                        fontSize: "var(--font-sm)",
                        cursor: "pointer",
                      }}
                    >
                      {weekdayName(day)}
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}
          {settings.enabled && exactAllowed === false ? (
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
              <HintText small>{t("reminders.inexactNotice")}</HintText>
              <Button size="sm" variant="ghost" onClick={() => void openExactAlarmSetting().then(setExactAllowed)}>
                {t("reminders.allowExact")}
              </Button>
            </div>
          ) : null}
          <ErrorText>{error}</ErrorText>
          {message ? <HintText small>{message}</HintText> : null}
          <Button onClick={save} loading={saving} disabled={settings.enabled && settings.days.length === 0}>
            {t("reminders.saveAction")}
          </Button>
        </>
      ) : null}
    </Card>
  );
}
