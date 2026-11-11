// Owner 2026-11-03: the allowance sheet downloads as Excel - a row per day, the totals at the foot.
import { describe, expect, it } from "vitest";

import type { AllowanceEntry } from "../../core/repositories/AllowanceRepository";
import { allowanceSheetTable, entryTotal } from "./allowanceSheetTable";

const t = (key: string, options?: Record<string, unknown>) => (options?.count !== undefined ? `${key}:${options.count}` : key);

const day = (date: string, extra: Partial<AllowanceEntry> = {}): AllowanceEntry => ({
  id: date, userId: "u1", userFullName: "Omar", entryDate: date, siteName: "Capital", siteId: null,
  clockInAt: null, clockOutAt: null, sessionCount: 0, workedMinutes: 0,
  mealAllowance: 0, expatriationAllowance: 200, transportationAllowance: 50, housingAllowance: 0, travelAllowance: 0, otherAllowance: 0, otherAllowanceNote: null,
  overtimeHours: 0, overtimeMinutes: 90, overtimeDays: 0, manualOverrides: {}, overtimeAmount: 37.5, extraDaysAmount: 0, lateMinutes: 0, lateAmount: 0,
  status: "draft", submittedAt: null, approvedAt: null, reviewNotes: null, sheetId: null,
  ...extra,
} as AllowanceEntry);

describe("allowanceSheetTable", () => {
  it("lists the days in order with their site and totals them", () => {
    const rows = allowanceSheetTable([day("2026-11-02", { siteName: "Plant" }), day("2026-11-01")], { t, language: "en", organizationName: "Ratomag", startDate: "2026-11-01", endDate: "2026-11-30" });
    expect(rows[0]).toEqual(["sheet.title"]);
    expect(rows[1]).toEqual(["Ratomag"]);
    const header = rows.findIndex((row) => row[0] === "sheet.day");
    expect(rows[header + 1][2]).toBe("Capital");
    expect(rows[header + 2][2]).toBe("Plant");
    const totals = rows[rows.length - 1];
    expect(totals[0]).toBe("sheet.total");
    expect(totals[5]).toBe(400); // expatriation, two days
    expect(totals[14]).toBe(2 * entryTotal(day("x")));
    expect(totals[11]).toBe("3:00"); // 90 + 90 minutes of overtime
  });

  it("adds the employee column when the sheet has several people", () => {
    const rows = allowanceSheetTable([day("2026-11-01"), day("2026-11-01", { id: "b", userId: "u2", userFullName: "Mona" })], { t, language: "en", organizationName: "", startDate: "2026-11-01", endDate: "2026-11-01" });
    expect(rows.find((row) => row[0] === "sheet.day")?.[2]).toBe("columns.employee");
    expect(rows[1]).toEqual(["sheet.employeeName", "sheet.employeesCount:2"]);
  });
});
