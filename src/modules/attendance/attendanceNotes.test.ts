// Owner 2026-10-18: no early-leave prompt; the employee's notes show in a
// Notes column of the attendance record (older early-leave reasons too).
import { describe, expect, it } from "vitest";

import i18n from "../../i18n";
import type { TodayAttendanceRow } from "../../core/repositories/ManagerRepository";
import { attendanceNoteLines } from "./attendanceNotes";

const t = i18n.getFixedT("en", "attendanceLog") as unknown as (key: string, options?: Record<string, unknown>) => string;
const row = (fields: Partial<TodayAttendanceRow>) =>
  ({ clockInNote: null, clockInActivity: null, clockOutNote: null, clockOutActivity: null, earlyLeaveReason: null, ...fields }) as TodayAttendanceRow;

describe("attendanceNoteLines", () => {
  it("lists the clock-in and clock-out notes, the activity once, and an older early-leave reason", () => {
    expect(
      attendanceNoteLines(row({ clockInNote: "Gate 2", clockInActivity: "Welding", clockOutNote: "Doctor appointment", clockOutActivity: "Welding", earlyLeaveReason: "Family" }), t),
    ).toEqual(["Clock in: Gate 2", t("activityLabel", { activity: "Welding" }), "Clock out: Doctor appointment", "Left early: Family"]);
  });

  it("is empty when nothing was written", () => {
    expect(attendanceNoteLines(row({}), t)).toEqual([]);
  });
});
