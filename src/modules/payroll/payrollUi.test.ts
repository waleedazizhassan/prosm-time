// 2026-11-08 payroll screens: the CSV import parser, the default period and the error wording.
import { describe, expect, it } from "vitest";

import { defaultPeriod, parseCsv, payrollError } from "./payrollUi";

const t = ((key: string) => key) as never;

describe("parseCsv", () => {
  it("reads quoted cells, commas inside quotes, a byte-order mark and Windows line ends", () => {
    const rows = parseCsv('\uFEFFemail,component,amount,notes\r\na@b.c,"مكافأة, شهرية",1500,"say ""hi"""\r\n\r\n');
    expect(rows).toEqual([["email", "component", "amount", "notes"], ["a@b.c", "مكافأة, شهرية", "1500", 'say "hi"']]);
  });

  it("understands semicolon files (Excel in many locales)", () => {
    expect(parseCsv("email;amount\nx@y.z;10,5\n")).toEqual([["email", "amount"], ["x@y.z", "10,5"]]);
  });
});

describe("defaultPeriod", () => {
  it("is the calendar month when the period starts on the 1st", () => {
    expect(defaultPeriod(1, new Date(2027, 4, 17))).toEqual({ start: "2027-05-01", end: "2027-05-31" });
  });

  it("runs from the start day to the day before it next month", () => {
    expect(defaultPeriod(26, new Date(2027, 4, 17))).toEqual({ start: "2027-04-26", end: "2027-05-25" });
    expect(defaultPeriod(26, new Date(2027, 4, 27))).toEqual({ start: "2027-05-26", end: "2027-06-25" });
  });
});

describe("payrollError", () => {
  it("turns the server's refusals into the payroll wording", () => {
    expect(payrollError("PAYROLL AUTHORITY REQUIRED: payroll.view", t)).toBe("payroll:errors.noAuthority");
    expect(payrollError("THIS CYCLE WAS CHANGED BY SOMEONE ELSE - RELOAD", t)).toBe("payroll:errors.changedBySomeoneElse");
    expect(payrollError("THIS PAYSLIP WAS ALREADY SENT", t)).toBe("payroll:errors.alreadySent");
    expect(payrollError(null, t)).toBe("payroll:errors.generic");
  });
});
