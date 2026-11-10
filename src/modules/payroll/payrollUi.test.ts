// 2026-11-08 payroll screens: the CSV import parser, the default period and the error wording.
import { describe, expect, it } from "vitest";

import { defaultPeriod, money, parseAmount, parseCsv, payrollError, setPayrollDigits, shownDigits } from "./payrollUi";

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

describe("parseAmount", () => {
  it("reads Latin, Arabic-Indic and Persian digits, Arabic decimal and thousands marks", () => {
    expect(parseAmount("4500")).toBe(4500);
    expect(parseAmount("٤٥٠٠")).toBe(4500);
    expect(parseAmount("۱۲")).toBe(12);
    expect(parseAmount("٤٨٧٫٤٧")).toBe(487.47);
    expect(parseAmount("17٬868")).toBe(17868);
    expect(parseAmount(" 6,5 ")).toBe(6.5);
  });
  it("empty is null, nonsense is NaN", () => {
    expect(parseAmount("  ")).toBeNull();
    expect(parseAmount("abc")).toBeNaN();
  });
});

describe("payroll digits (owner 2026-11-10)", () => {
  it("shows amounts in the payroll country's digits and reads them back", () => {
    setPayrollDigits("arab");
    expect(shownDigits("4500.5")).toBe("\u0664\u0665\u0660\u0660\u066B\u0665");
    expect(parseAmount(shownDigits("4500.5"))).toBe(4500.5);
    expect(money(24500)).toContain("\u0662\u0664");
    setPayrollDigits("latn");
    expect(shownDigits("\u0664\u0665\u0660\u0660")).toBe("4500");
    expect(money(24500)).toBe("24,500.00");
    setPayrollDigits(null);
  });
});
