import type { TFunction } from "i18next";

import humanizeBackendError from "../../core/utils/humanizeBackendError";
import saveGeneratedFile from "../../core/utils/saveGeneratedFile";
import type { CycleStatus } from "../../core/repositories/PayrollCycleRepository";

// Small shared pieces of the payroll screens (2026-11-08).

/** An amount typed on any keyboard: Arabic-Indic and Persian digits, Arabic comma/decimal sign (owner 2026-11-09:
 *  "the fields don't save" - number fields dropped digits typed on an Arabic keyboard). Empty -> null. */
export function parseAmount(text: string): number | null {
  const ascii = text
    .trim()
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u066B\u060C,]/g, ".")
    .replace(/[\u066C\s]/g, "");
  if (ascii === "") return null;
  const value = Number(ascii);
  return Number.isFinite(value) ? value : NaN;
}

// Owner 2026-11-10: payroll numbers in one shape, by the payroll country (usePayrollDigits sets it).
export type DigitSystem = "arab" | "latn";
let digitSystem: DigitSystem | null = null;
export function setPayrollDigits(system: DigitSystem | null) {
  digitSystem = system;
}

export const money = (value: number | string | null | undefined) =>
  Number(value ?? 0).toLocaleString(digitSystem === "arab" ? "ar-EG" : digitSystem === "latn" ? "en-US" : undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A typed amount shown in the payroll's digits (parseAmount reads both). */
export function shownDigits(text: string): string {
  if (digitSystem === "arab") return text.replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d))).replace(/\./g, String.fromCharCode(0x066b));
  if (digitSystem === "latn") {
    const parsed = text.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/\u066B/g, ".");
    return parsed;
  }
  return text;
}

export const STATUS_BADGE: Record<CycleStatus, string> = {
  draft: "neutral",
  in_review: "pending",
  approved: "active",
  locked: "active",
  reopened: "pending",
  cancelled: "inactive",
};

/** A server refusal in words: the app's known messages, else the payroll ones, else as sent. */
export function payrollError(message: string | null | undefined, t: TFunction): string {
  if (!message) return t("payroll:errors.generic");
  const known = humanizeBackendError(message, t);
  if (known && known !== message) return known;
  const codes: [RegExp, string][] = [
    [/PAYROLL AUTHORITY REQUIRED/, "noAuthority"],
    [/A RATE MUST BE BETWEEN/, "statutoryRate"],
    [/BRACKETS MUST RISE|LAST BRACKET HAS NO|AT LEAST ONE BRACKET/, "statutoryBrackets"],
    [/MAXIMUM INSURABLE WAGE/, "statutoryWage"],
    [/FEATURE NOT IN PLAN: payroll/, "notInPlan"],
    [/CHANGED BY SOMEONE ELSE/, "changedBySomeoneElse"],
    [/ALREADY COVERS THIS PERIOD/, "periodTaken"],
    [/BLOCKING ERRORS/, "blockingErrors"],
    [/ACKNOWLEDGE THE WARNINGS/, "acknowledgeWarnings"],
    [/WHOEVER SUBMITTED/, "submitterCannotApprove"],
    [/LOCKED CYCLE ONLY|NOT PUBLISHED/, "notPublished"],
    [/REASON IS REQUIRED/, "reasonRequired"],
    [/ALREADY ASKED/, "alreadyAsked"],
    [/ALREADY SENT/, "alreadySent"],
    [/BEING SENT/, "beingSent"],
    [/NO EMAIL/, "noEmail"],
    [/CREATE THE PAYROLL PROFILE FIRST/, "profileFirst"],
    // 2026-11-10: the official name on the payslip
    [/LEGAL NAME IS REQUIRED/, "legalNameRequired"],
    [/LEGAL NAME MUST BE IN ARABIC/, "legalNameArabic"],
    [/CANNOT BE CHANGED IN STATUS/, "notEditable"],
    [/YOUR OWN REQUEST/, "ownRequest"],
    // 2026-11-10: a choice left empty (an item, a person) - never show the database's own words
    [/invalid input syntax for type uuid|COMPONENT REQUIRED|COMPONENT NOT FOUND/i, "chooseItem"],
    [/BASIC SALARY CANNOT BE DELETED/, "basicCannotBeDeleted"],
  ];
  const hit = codes.find(([pattern]) => pattern.test(message));
  return hit ? t(`payroll:errors.${hit[1]}`) : message;
}

export async function saveXlsx(filename: string, data: Uint8Array): Promise<void> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  await saveGeneratedFile(filename, new Blob([copy.buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
}

/** The default next period from the organisation's start day (1 = the calendar month). */
export function defaultPeriod(startDay: number, today = new Date()): { start: string; end: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const day = Math.min(Math.max(startDay || 1, 1), 28);
  let start = new Date(today.getFullYear(), today.getMonth(), day);
  if (start > today) start = new Date(today.getFullYear(), today.getMonth() - 1, day);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, day - 1);
  return { start: iso(start), end: iso(end) };
}

/** A CSV line split into cells (quotes, commas or semicolons) - for the import file. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  const delimiter = (text.split("\n")[0].match(/;/g)?.length ?? 0) > (text.split("\n")[0].match(/,/g)?.length ?? 0) ? ";" : ",";
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell.trim()); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell.trim()); cell = "";
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((value) => value !== "")) rows.push(row);
  return rows.map((r) => r.map((value, index) => (index === 0 ? value.replace(/^\uFEFF/, "") : value)));
}

// Owner 2026-11-10: the official name on the payslip, in the language of the payroll's country - the
// Arab League countries write it in Arabic letters (the server checks the same).
const ARABIC_NAME_COUNTRIES = new Set(["EG", "SA", "SD", "IQ", "SY", "YE", "KW", "QA", "BH", "OM", "JO", "LB", "PS", "AE", "MA", "DZ", "TN", "LY", "MR", "SO", "DJ", "KM"]);
export function nameMustBeArabic(countryCode: string | null | undefined): boolean {
  return ARABIC_NAME_COUNTRIES.has((countryCode ?? "EG").toUpperCase());
}
/** null when the name is fine, else the error's key under payroll:errors. */
export function legalNameProblem(name: string, inArabic: boolean): "legalNameRequired" | "legalNameArabic" | null {
  if (!name.trim()) return "legalNameRequired";
  if (inArabic && (/[A-Za-z]/.test(name) || !/[\u0600-\u06FF]/.test(name))) return "legalNameArabic";
  return null;
}
