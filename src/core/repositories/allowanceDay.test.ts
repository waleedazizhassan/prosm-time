// Audit 4.7 - an allowance entry covers the whole day: Omar's three
// sessions show his first clock-in and his last clock-out.
import { describe, expect, it } from "vitest";

import { summarizeDay } from "./AllowanceRepository";

describe("summarizeDay", () => {
  it("uses the first clock-in, the last clock-out and the total of every session", () => {
    expect(
      summarizeDay([
        { clockInAt: "2026-10-12T13:00:00.000Z", clockOutAt: "2026-10-12T16:00:00.000Z" },
        { clockInAt: "2026-10-12T06:00:00.000Z", clockOutAt: "2026-10-12T09:30:00.000Z" },
        { clockInAt: "2026-10-12T10:00:00.000Z", clockOutAt: "2026-10-12T12:10:00.000Z" },
      ]),
    ).toEqual({ clockInAt: "2026-10-12T06:00:00.000Z", clockOutAt: "2026-10-12T16:00:00.000Z", sessionCount: 3, workedMinutes: 520 });
  });

  it("has no last clock-out while a session is still open", () => {
    expect(
      summarizeDay([
        { clockInAt: "2026-10-12T06:00:00.000Z", clockOutAt: "2026-10-12T09:00:00.000Z" },
        { clockInAt: "2026-10-12T10:00:00.000Z", clockOutAt: null },
      ]),
    ).toEqual({ clockInAt: "2026-10-12T06:00:00.000Z", clockOutAt: null, sessionCount: 2, workedMinutes: 180 });
  });
});
