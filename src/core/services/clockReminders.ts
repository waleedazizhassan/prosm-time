// Owner 2026-10-18 ("a clear reminder to clock in and out"): when the phone
// should remind its owner. Clocked in - shortly after the shift's end (the
// shift scheduled for today, otherwise the site's own end time). Not
// clocked in - a few minutes before the next scheduled shift starts.
import type { MyShiftRow } from "../repositories/ShiftRepository";
import { localIsoDate } from "../../modules/attendance/periods";

export const CLOCK_OUT_GRACE_MINUTES = 10;
export const CLOCK_IN_LEAD_MINUTES = 5;

export interface ClockReminder {
  kind: "clockIn" | "clockOut";
  at: Date;
  // The shift's own time ("17:00") and, for a clock-in, the site's name.
  time: string;
  siteName: string | null;
}

interface OpenSession {
  siteId: string | null;
  clockInAt: string;
}

const atTime = (day: string, time: string) => {
  const [year, month, date] = day.split("-").map(Number);
  const [hours, minutes] = time.split(":").map(Number);
  return new Date(year, month - 1, date, hours, minutes);
};
const addMinutes = (d: Date, minutes: number) => new Date(d.getTime() + minutes * 60000);
const hhmm = (time: string) => time.slice(0, 5);

export function nextClockReminder(
  now: Date,
  session: OpenSession | null,
  shifts: MyShiftRow[],
  siteEndTimes: Record<string, string | null>,
): ClockReminder | null {
  const scheduled = shifts.filter((shift) => shift.status === "scheduled");

  if (session) {
    const clockIn = new Date(session.clockInAt);
    // The shift scheduled on the day the person clocked in, otherwise the site's own end time.
    const today = scheduled.find((shift) => shift.shiftDate === localIsoDate(clockIn));
    const endTime = today?.endTime ?? (session.siteId ? siteEndTimes[session.siteId] ?? null : null);
    if (!endTime) return null;
    let end = atTime(localIsoDate(clockIn), endTime);
    if (today?.crossesMidnight || end <= clockIn) end = addMinutes(end, 24 * 60);
    const at = addMinutes(end, CLOCK_OUT_GRACE_MINUTES);
    return at > now ? { kind: "clockOut", at, time: hhmm(endTime), siteName: null } : null;
  }

  const upcoming = scheduled
    .map((shift) => ({ shift, start: atTime(shift.shiftDate, shift.startTime) }))
    .filter(({ start }) => addMinutes(start, -CLOCK_IN_LEAD_MINUTES) > now)
    .sort((a, b) => a.start.getTime() - b.start.getTime())[0];
  if (!upcoming) return null;
  return { kind: "clockIn", at: addMinutes(upcoming.start, -CLOCK_IN_LEAD_MINUTES), time: hhmm(upcoming.shift.startTime), siteName: upcoming.shift.siteName || null };
}
