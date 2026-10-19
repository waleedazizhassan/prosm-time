// Owner 2026-10-19: day / week (Sunday to Saturday) / month, counted the same everywhere.
import { describe, expect, it } from "vitest";

import { formatHours, periodHours, periodRange } from "./periods";

// Wednesday 21 October 2026, 15:00 local time.
const now = new Date(2026, 9, 21, 15, 0);

describe("periods", () => {
  it("starts the week on Sunday and the month on the 1st", () => {
    expect(periodRange("today", now)).toEqual({ start: "2026-10-21", end: "2026-10-21" });
    expect(periodRange("week", now)).toEqual({ start: "2026-10-18", end: "2026-10-21" });
    expect(periodRange("month", now)).toEqual({ start: "2026-10-01", end: "2026-10-21" });
    // A Sunday is the first day of its own week.
    expect(periodRange("week", new Date(2026, 9, 18, 9)).start).toBe("2026-10-18");
  });

  it("adds up the shifts of each period, an open shift up to now", () => {
    const rows = [
      { clockInAt: new Date(2026, 9, 21, 8).toISOString(), clockOutAt: null },
      { clockInAt: new Date(2026, 9, 19, 9).toISOString(), clockOutAt: new Date(2026, 9, 19, 17, 30).toISOString() },
      { clockInAt: new Date(2026, 9, 17, 9).toISOString(), clockOutAt: new Date(2026, 9, 17, 13).toISOString() },
    ];
    expect(periodHours(rows, "today", now)).toBe(7);
    expect(periodHours(rows, "week", now)).toBe(15.5);
    expect(periodHours(rows, "month", now)).toBe(19.5);
    expect(formatHours(15.5)).toBe("15:30");
  });
});
