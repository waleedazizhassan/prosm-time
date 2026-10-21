import { describe, expect, it } from "vitest";

import { DEFAULT_REMINDERS, remindersToSchedule } from "./personalReminders";

describe("personal reminders", () => {
  it("schedules nothing while switched off", () => {
    expect(remindersToSchedule(DEFAULT_REMINDERS)).toEqual([]);
  });

  it("schedules a clock-in and a clock-out reminder for each chosen day, Sunday = weekday 1", () => {
    const scheduled = remindersToSchedule({ enabled: true, clockIn: "07:45", clockOut: "16:30", days: [4, 0] });
    expect(scheduled).toEqual([
      { id: 7200, kind: "clockIn", weekday: 1, hour: 7, minute: 45 },
      { id: 7300, kind: "clockOut", weekday: 1, hour: 16, minute: 30 },
      { id: 7204, kind: "clockIn", weekday: 5, hour: 7, minute: 45 },
      { id: 7304, kind: "clockOut", weekday: 5, hour: 16, minute: 30 },
    ]);
  });
});
