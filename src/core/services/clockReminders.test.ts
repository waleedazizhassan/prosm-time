// Owner 2026-10-18: a clear reminder to clock in and out.
import { describe, expect, it } from "vitest";

import type { MyShiftRow } from "../repositories/ShiftRepository";
import { nextClockReminder } from "./clockReminders";

const shift = (shiftDate: string, startTime: string, endTime: string, extra: Partial<MyShiftRow> = {}): MyShiftRow => ({
  id: `${shiftDate}-${startTime}`,
  siteName: "Tower B",
  shiftDate,
  startTime,
  endTime,
  crossesMidnight: endTime <= startTime,
  status: "scheduled",
  notes: null,
  cancelledReason: null,
  ...extra,
});

describe("nextClockReminder", () => {
  it("reminds to clock out 10 minutes after today's scheduled end", () => {
    const now = new Date(2026, 9, 20, 12, 0);
    const session = { siteId: "s1", clockInAt: new Date(2026, 9, 20, 8, 2).toISOString() };
    const reminder = nextClockReminder(now, session, [shift("2026-10-20", "08:00:00", "16:00:00")], { s1: "17:00:00" });
    expect(reminder).toMatchObject({ kind: "clockOut", time: "16:00" });
    expect(reminder?.at).toEqual(new Date(2026, 9, 20, 16, 10));
  });

  it("uses the site's end time when nothing is scheduled, and the next day for a night shift", () => {
    const now = new Date(2026, 9, 20, 23, 0);
    const session = { siteId: "s1", clockInAt: new Date(2026, 9, 20, 22, 0).toISOString() };
    expect(nextClockReminder(now, session, [], { s1: "06:00:00" })?.at).toEqual(new Date(2026, 9, 21, 6, 10));
  });

  it("says nothing once the end has passed, or when no end is known", () => {
    const session = { siteId: "s1", clockInAt: new Date(2026, 9, 20, 8, 0).toISOString() };
    expect(nextClockReminder(new Date(2026, 9, 20, 18, 0), session, [], { s1: "16:00:00" })).toBeNull();
    expect(nextClockReminder(new Date(2026, 9, 20, 9, 0), { siteId: null, clockInAt: session.clockInAt }, [], {})).toBeNull();
  });

  it("reminds to clock in 5 minutes before the next scheduled shift, skipping cancelled ones", () => {
    const now = new Date(2026, 9, 20, 18, 0);
    const shifts = [
      shift("2026-10-21", "07:00:00", "15:00:00", { status: "cancelled" }),
      shift("2026-10-22", "08:00:00", "16:00:00"),
      shift("2026-10-20", "08:00:00", "16:00:00"),
    ];
    const reminder = nextClockReminder(now, null, shifts, {});
    expect(reminder).toMatchObject({ kind: "clockIn", time: "08:00", siteName: "Tower B" });
    expect(reminder?.at).toEqual(new Date(2026, 9, 22, 7, 55));
  });
});
