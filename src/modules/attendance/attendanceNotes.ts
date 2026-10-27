import type { TodayAttendanceRow } from "../../core/repositories/ManagerRepository";

type TFunc = (key: string, options?: Record<string, unknown>) => string;

// Owner 2026-10-18: everything the employee wrote, for the Notes column of
// the Attendance Log and its PDF - the clock-in and clock-out notes and
// activity, and a reason given by the former early-leave prompt.
// Owner 2026-10-27 ("a site change mid-shift: the record keeps both sites"):
// the site the shift began at - the session itself carries the latest one.
export function startingSiteName(row: TodayAttendanceRow, t: TFunc): string {
  if (row.siteChanges.length === 0) return row.siteName || "—";
  return row.siteChanges[0].fromSiteName ?? t("noRegisteredSite");
}

export function attendanceNoteLines(row: TodayAttendanceRow, t: TFunc, time?: (iso: string) => string): string[] {
  return [
    // every site change of the shift, from - to - when
    ...row.siteChanges.map((change) =>
      t("notes.siteChange", { from: change.fromSiteName ?? t("noRegisteredSite"), to: change.toSiteName || t("noRegisteredSite"), time: time ? time(change.changedAt) : "" }),
    ),
    row.clockInNote ? t("notes.clockIn", { note: row.clockInNote }) : null,
    row.clockInActivity ? t("activityLabel", { activity: row.clockInActivity }) : null,
    row.clockOutNote ? t("notes.clockOut", { note: row.clockOutNote }) : null,
    row.clockOutActivity && row.clockOutActivity !== row.clockInActivity ? t("activityLabel", { activity: row.clockOutActivity }) : null,
    row.earlyLeaveReason ? t("notes.earlyLeave", { reason: row.earlyLeaveReason }) : null,
    // Owner 2026-10-20: a fake location stays on record here; the hours still count.
    row.clockInMockLocation ? t("notes.mockClockIn") : null,
    row.clockOutMockLocation ? t("notes.mockClockOut") : null,
  ].filter((line): line is string => Boolean(line));
}
