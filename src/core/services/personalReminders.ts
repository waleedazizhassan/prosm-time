// Owner 2026-10-21 ("where is the reminder the employee can set to remember
// to clock in and out?"): each person picks their own clock-in and clock-out
// reminder times and working days. The phone keeps them as repeating weekly
// notifications, so they arrive with the app closed and without a
// connection. Kept on the device (a phone's reminders belong to that phone).

export interface PersonalReminders {
  enabled: boolean;
  clockIn: string; // "HH:MM"
  clockOut: string; // "HH:MM"
  days: number[]; // 0 = Sunday ... 6 = Saturday
}

export const DEFAULT_REMINDERS: PersonalReminders = { enabled: false, clockIn: "08:00", clockOut: "17:00", days: [0, 1, 2, 3, 4] };

const KEY = "prosm_time_personal_reminders_v1";
// Notification ids: 7200 + day for clock-in, 7300 + day for clock-out.
const IN_BASE = 7200;
const OUT_BASE = 7300;
export const ALL_REMINDER_IDS = [0, 1, 2, 3, 4, 5, 6].flatMap((day) => [IN_BASE + day, OUT_BASE + day]);

const validTime = (value: unknown) => typeof value === "string" && /^\d{2}:\d{2}$/.test(value);

export function loadReminders(userId: string): PersonalReminders {
  try {
    const raw = JSON.parse(localStorage.getItem(`${KEY}:${userId}`) ?? "null") as Partial<PersonalReminders> | null;
    if (!raw) return DEFAULT_REMINDERS;
    return {
      enabled: Boolean(raw.enabled),
      clockIn: validTime(raw.clockIn) ? (raw.clockIn as string) : DEFAULT_REMINDERS.clockIn,
      clockOut: validTime(raw.clockOut) ? (raw.clockOut as string) : DEFAULT_REMINDERS.clockOut,
      days: Array.isArray(raw.days) ? raw.days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6) : DEFAULT_REMINDERS.days,
    };
  } catch {
    return DEFAULT_REMINDERS;
  }
}

export function storeReminders(userId: string, reminders: PersonalReminders): void {
  try {
    localStorage.setItem(`${KEY}:${userId}`, JSON.stringify(reminders));
  } catch {
    // storage unavailable - the phone's scheduled reminders still stand
  }
}

export interface ScheduledReminder {
  id: number;
  kind: "clockIn" | "clockOut";
  // Capacitor's weekly schedule: weekday 1 = Sunday ... 7 = Saturday.
  weekday: number;
  hour: number;
  minute: number;
}

/** The weekly notifications these settings stand for (none when off). */
export function remindersToSchedule(reminders: PersonalReminders): ScheduledReminder[] {
  if (!reminders.enabled) return [];
  const [inHour, inMinute] = reminders.clockIn.split(":").map(Number);
  const [outHour, outMinute] = reminders.clockOut.split(":").map(Number);
  return [...new Set(reminders.days)]
    .sort((a, b) => a - b)
    .flatMap((day) => [
      { id: IN_BASE + day, kind: "clockIn" as const, weekday: day + 1, hour: inHour, minute: inMinute },
      { id: OUT_BASE + day, kind: "clockOut" as const, weekday: day + 1, hour: outHour, minute: outMinute },
    ]);
}
