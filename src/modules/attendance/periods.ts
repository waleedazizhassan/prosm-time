// Owner 2026-10-19: an employee looks at their own time by day, week and
// month; the week runs Sunday to Saturday. Shared by the employee's home
// page and the Attendance Record so both count the same way.
export type Period = "today" | "week" | "month";

export const PERIODS: Period[] = ["today", "week", "month"];

// A day in the device's own time zone (not UTC), e.g. 2026-10-19.
export function localIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function periodRange(period: Period, now: Date = new Date()): { start: string; end: string } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === "today") return { start: localIsoDate(today), end: localIsoDate(today) };
  if (period === "week") {
    const sunday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay());
    return { start: localIsoDate(sunday), end: localIsoDate(today) };
  }
  return { start: localIsoDate(new Date(today.getFullYear(), today.getMonth(), 1)), end: localIsoDate(today) };
}

export function isPeriod(value: string | null): value is Period {
  return value === "today" || value === "week" || value === "month";
}

/** Hours of one shift; a shift still open counts up to now. */
export function sessionHours(row: { clockInAt: string; clockOutAt: string | null }, now: Date = new Date()): number {
  const end = row.clockOutAt ? new Date(row.clockOutAt) : now;
  return Math.max(0, (end.getTime() - new Date(row.clockInAt).getTime()) / 3600000);
}

/** Total hours of the shifts that started within the period. */
export function periodHours(rows: { clockInAt: string; clockOutAt: string | null }[], period: Period, now: Date = new Date()): number {
  const { start, end } = periodRange(period, now);
  return rows.reduce((sum, row) => {
    const day = localIsoDate(new Date(row.clockInAt));
    return day >= start && day <= end ? sum + sessionHours(row, now) : sum;
  }, 0);
}

/** 7.5 -> "7:30" */
export function formatHours(hours: number): string {
  const minutes = Math.round(hours * 60);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}
