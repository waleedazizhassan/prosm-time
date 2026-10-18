import type { TodayAttendanceRow } from "../../core/repositories/ManagerRepository";

type TFunc = (key: string, options?: Record<string, unknown>) => string;

// Owner 2026-10-18: everything the employee wrote, for the Notes column of
// the Attendance Log and its PDF - the clock-in and clock-out notes and
// activity, and a reason given by the former early-leave prompt.
export function attendanceNoteLines(row: TodayAttendanceRow, t: TFunc): string[] {
  return [
    row.clockInNote ? t("notes.clockIn", { note: row.clockInNote }) : null,
    row.clockInActivity ? t("activityLabel", { activity: row.clockInActivity }) : null,
    row.clockOutNote ? t("notes.clockOut", { note: row.clockOutNote }) : null,
    row.clockOutActivity && row.clockOutActivity !== row.clockInActivity ? t("activityLabel", { activity: row.clockOutActivity }) : null,
    row.earlyLeaveReason ? t("notes.earlyLeave", { reason: row.earlyLeaveReason }) : null,
  ].filter((line): line is string => Boolean(line));
}
