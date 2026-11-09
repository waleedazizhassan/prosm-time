import type { TFunction } from "i18next";

import humanizeBackendError from "../../core/utils/humanizeBackendError";
import saveGeneratedFile from "../../core/utils/saveGeneratedFile";
import type { CycleStatus } from "../../core/repositories/PayrollCycleRepository";

// Small shared pieces of the payroll screens (2026-11-08).

export const money = (value: number | string | null | undefined) =>
  Number(value ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
    [/CANNOT BE CHANGED IN STATUS/, "notEditable"],
    [/YOUR OWN REQUEST/, "ownRequest"],
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
