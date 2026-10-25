import type { jsPDF } from "jspdf";
import type { AllowanceEntry, AllowanceLine } from "../../core/repositories/AllowanceRepository";
import { formatTimeOnly } from "../../core/utils/formatDate";
import { renderHtmlToPdf, escapeHtml } from "../../core/utils/htmlToPdf";
import prosmLogo from "../../assets/prosm-logo-pdf.png";

type TFunc = (key: string, options?: Record<string, unknown>) => string;

export interface SheetContext {
  startDate: string;
  endDate: string;
  languageCode: string;
  t: TFunc;
  organizationName: string;
  organizationLogoUrl?: string | null;
  // v2.3.43 step 18 (item 16): public holidays in the period, and the
  // person's unpaid-leave deductions (taken from pay, not from allowances).
  holidays?: { name: string; startDate: string; endDate: string }[];
  deductions?: { workDate: string; amount: number; currency: string }[];
}

// Owner 2026-10-20 ("the allowance sheet should look like this when I export
// it as PDF" - the owner's own PROSM Allow sheet): an employee's sheet lists
// every day of the period (days with nothing are shaded), the totals, a box
// per allowance in money, the grand total, a line per site, and signature
// lines for the employee, the project manager and accounts. A manager's
// combined sheet has one line of totals per chosen employee.

const BRAND = "#1e6fd9";
const LINE = "#cbd5e1";

const money = (value: number, locale: string) => (value === 0 ? "" : value.toLocaleString(locale, { maximumFractionDigits: 2 }));
const moneyAlways = (value: number, locale: string) => value.toLocaleString(locale, { maximumFractionDigits: 2 });

function allowanceSum(entry: AllowanceEntry): number {
  return entry.mealAllowance + entry.expatriationAllowance + entry.transportationAllowance + entry.housingAllowance + entry.travelAllowance + entry.otherAllowance;
}

function extraSum(entry: AllowanceEntry): number {
  return entry.overtimeAmount + entry.extraDaysAmount;
}

function dayList(startDate: string, endDate: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  for (let guard = 0; cursor <= end && guard < 62; guard += 1) {
    days.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`);
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function shortDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return year && month && day ? `${day}/${month}` : iso;
}

function longDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return year && month && day ? `${day}/${month}/${year}` : iso;
}

function header(ctx: SheetContext, subtitle: string): string {
  const { t, organizationName, organizationLogoUrl } = ctx;
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:3px solid ${BRAND};padding-bottom:12px;margin-bottom:14px;">
      ${organizationLogoUrl ? `<img src="${escapeHtml(organizationLogoUrl)}" style="height:52px;max-width:120px;object-fit:contain;" />` : `<div style="width:52px;"></div>`}
      <div style="text-align:center;flex:1;">
        <div style="font-size:22px;font-weight:800;">${escapeHtml(t("sheet.title"))}</div>
        <div style="font-size:12px;color:#475569;margin-top:2px;">${escapeHtml(subtitle)}${organizationName ? ` — ${escapeHtml(organizationName)}` : ""}</div>
      </div>
      <img src="${prosmLogo}" style="height:52px;width:52px;object-fit:contain;" />
    </div>`;
}

function footer(ctx: SheetContext): string {
  const { t, languageCode } = ctx;
  return `
    <div style="display:flex;justify-content:space-between;gap:24px;margin-top:40px;font-size:12px;font-weight:700;color:#0f172a;">
      ${[t("sheet.employeeSignature"), t("sheet.projectManager"), t("sheet.accounts")]
        .map((label) => `<div style="flex:1;text-align:center;"><div style="border-top:1px solid #0f172a;margin-bottom:6px;"></div>${escapeHtml(label)}</div>`)
        .join("")}
    </div>
    <div style="text-align:center;margin-top:14px;font-size:10px;color:#94a3b8;">${escapeHtml(new Date().toLocaleString(languageCode))} · PROSM Time</div>`;
}

const cell = (content: string, extra = "") => `<td style="padding:4px 6px;border:1px solid ${LINE};text-align:center;${extra}">${content}</td>`;
const head = (content: string) => `<th style="padding:5px 6px;border:1px solid ${LINE};background:#eef2f7;font-size:10px;line-height:1.25;">${escapeHtml(content)}</th>`;

/** One employee's sheet: every day of the period, the totals in money, a line per site. */
export function buildEmployeeAllowanceSheetPdf(entries: AllowanceEntry[], employeeName: string, ctx: SheetContext): Promise<jsPDF> {
  const { t, languageCode, startDate, endDate } = ctx;
  const isRtl = languageCode === "ar";
  const byDay = new Map(entries.map((entry) => [entry.entryDate, entry]));
  const showHousing = entries.some((entry) => entry.housingAllowance > 0);
  const showOther = entries.some((entry) => entry.otherAllowance > 0);

  const columns = [
    t("sheet.day"),
    t("sheet.date"),
    t("sheet.in"),
    t("sheet.out"),
    t("sheet.site"),
    t("sheet.extraDays"),
    t("prices.field.expatriation"),
    t("prices.field.transportation"),
    t("prices.field.travel"),
    t("prices.field.meal"),
    ...(showHousing ? [t("prices.field.housing")] : []),
    ...(showOther ? [t("prices.field.other")] : []),
    t("sheet.overtimeHours"),
    t("sheet.managerApproval"),
  ];

  const rows = dayList(startDate, endDate)
    .map((iso) => {
      const entry = byDay.get(iso);
      const weekday = new Date(`${iso}T00:00:00`).toLocaleDateString(languageCode, { weekday: "long" });
      const holiday = holidayOn(ctx, iso);
      const shade = holiday ? "background:#fef9c3;" : entry ? "" : "background:#f1f5f9;";
      // a value the manager changed during review carries a mark (step 5)
      const edited = (line: AllowanceLine, text: string) => (entry?.manualOverrides[line] ? `${text}${EDIT_MARK}` : text);
      const values = entry
        ? [
            entry.clockInAt ? escapeHtml(formatTimeOnly(entry.clockInAt, languageCode)) : "",
            entry.clockOutAt ? escapeHtml(formatTimeOnly(entry.clockOutAt, languageCode)) : "",
            escapeHtml(entry.siteName ?? ""),
            edited("extraDays", entry.overtimeDays ? String(entry.overtimeDays) : ""),
            edited("expatriation", money(entry.expatriationAllowance, languageCode)),
            edited("transportation", money(entry.transportationAllowance, languageCode)),
            edited("travel", money(entry.travelAllowance, languageCode)),
            edited("meal", money(entry.mealAllowance, languageCode)),
            ...(showHousing ? [edited("housing", money(entry.housingAllowance, languageCode))] : []),
            ...(showOther ? [edited("other", money(entry.otherAllowance, languageCode))] : []),
            edited("overtime", entry.overtimeHours ? String(Number(entry.overtimeHours.toFixed(2))) : ""),
            "",
          ]
        : Array.from({ length: columns.length - 2 }, () => "");
      const dayLabel = holiday ? `${escapeHtml(weekday)}<div style="font-size:9px;color:#854d0e;">${escapeHtml(holiday)}</div>` : escapeHtml(weekday);
      return `<tr>${cell(dayLabel, shade + "text-align:start;")}${cell(shortDate(iso), shade)}${values.map((value) => cell(value, shade)).join("")}</tr>`;
    })
    .join("");

  const sum = (pick: (entry: AllowanceEntry) => number) => entries.reduce((total, entry) => total + pick(entry), 0);
  const totals = {
    extraDays: sum((e) => e.overtimeDays),
    expatriation: sum((e) => e.expatriationAllowance),
    transportation: sum((e) => e.transportationAllowance),
    travel: sum((e) => e.travelAllowance),
    meal: sum((e) => e.mealAllowance),
    housing: sum((e) => e.housingAllowance),
    other: sum((e) => e.otherAllowance),
    overtimeHours: sum((e) => e.overtimeHours),
    extraDaysValue: sum((e) => e.extraDaysAmount),
    overtimeValue: sum((e) => e.overtimeAmount),
  };
  const grand = sum((e) => allowanceSum(e) + extraSum(e));

  const totalsRow = `<tr style="font-weight:800;">
      <td colspan="5" style="padding:5px 6px;border:1px solid ${LINE};text-align:center;">${escapeHtml(t("sheet.total"))}</td>
      ${cell(String(Number(totals.extraDays.toFixed(1))))}
      ${cell(moneyAlways(totals.expatriation, languageCode))}
      ${cell(moneyAlways(totals.transportation, languageCode))}
      ${cell(moneyAlways(totals.travel, languageCode))}
      ${cell(moneyAlways(totals.meal, languageCode))}
      ${showHousing ? cell(moneyAlways(totals.housing, languageCode)) : ""}
      ${showOther ? cell(moneyAlways(totals.other, languageCode)) : ""}
      ${cell(String(Number(totals.overtimeHours.toFixed(2))))}
      ${cell("")}
    </tr>`;

  const boxes: [string, number][] = [
    [t("prices.field.expatriation"), totals.expatriation],
    [t("prices.field.transportation"), totals.transportation],
    [t("prices.field.travel"), totals.travel],
    [t("prices.field.meal"), totals.meal],
    ...(showHousing ? ([[t("prices.field.housing"), totals.housing]] as [string, number][]) : []),
    ...(showOther ? ([[t("prices.field.other"), totals.other]] as [string, number][]) : []),
    [t("sheet.extraDaysValue"), totals.extraDaysValue],
    [t("sheet.overtimeValue"), totals.overtimeValue],
  ];

  const bySite = new Map<string, { days: number; allowances: number; extra: number }>();
  for (const entry of entries) {
    const key = entry.siteName || t("sheet.noSite");
    const row = bySite.get(key) ?? { days: 0, allowances: 0, extra: 0 };
    row.days += entry.clockInAt ? 1 : 0;
    row.allowances += allowanceSum(entry);
    row.extra += extraSum(entry);
    bySite.set(key, row);
  }

  const container = document.createElement("div");
  container.dir = isRtl ? "rtl" : "ltr";
  container.style.cssText = "width:900px;padding:30px 34px;background:#ffffff;color:#0f172a;font-family:'IBM Plex Sans Arabic','Segoe UI',Tahoma,Arial,sans-serif;";
  container.innerHTML = `
    ${header(ctx, t("sheet.subtitle"))}
    <div style="display:flex;justify-content:space-between;gap:16px;font-size:14px;font-weight:800;margin-bottom:10px;">
      <div>${escapeHtml(t("sheet.employeeName"))} : ${escapeHtml(employeeName)}</div>
      <div>${escapeHtml(t("sheet.periodFrom"))} : ${longDate(startDate)} &nbsp; ${escapeHtml(t("sheet.periodTo"))} : ${longDate(endDate)}</div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:10.5px;">
      <thead><tr>${columns.map(head).join("")}</tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>${totalsRow}</tfoot>
    </table>

    <div style="display:grid;grid-template-columns:repeat(${Math.min(boxes.length, 6)}, 1fr);gap:8px;margin-top:16px;">
      ${boxes
        .map(
          ([label, value]) => `<div style="border:1px solid ${LINE};border-radius:6px;padding:8px;text-align:center;">
            <div style="font-size:11px;color:#475569;">${escapeHtml(label)}</div>
            <div style="font-size:15px;font-weight:800;margin-top:2px;">${moneyAlways(value, languageCode)}</div>
          </div>`,
        )
        .join("")}
    </div>
    <div style="margin-top:10px;padding:10px;border-radius:6px;background:${BRAND};color:#ffffff;text-align:center;">
      <div style="font-size:12px;opacity:0.9;">${escapeHtml(t("sheet.grandTotal"))}</div>
      <div style="font-size:20px;font-weight:800;">${moneyAlways(grand, languageCode)}</div>
    </div>

    <table style="width:70%;margin:16px auto 0;border-collapse:collapse;font-size:11px;">
      <thead><tr>${[t("sheet.site"), t("sheet.days"), t("sheet.allowances"), t("sheet.extra"), t("sheet.total")].map(head).join("")}</tr></thead>
      <tbody>
        ${[...bySite.entries()]
          .map(([site, row]) => `<tr>${cell(escapeHtml(site))}${cell(String(row.days))}${cell(moneyAlways(row.allowances, languageCode))}${cell(moneyAlways(row.extra, languageCode))}${cell(`<strong>${moneyAlways(row.allowances + row.extra, languageCode)}</strong>`)}</tr>`)
          .join("")}
      </tbody>
    </table>
    ${sheetNotes(entries, ctx)}
    ${footer(ctx)}
  `;
  return renderHtmlToPdf(container);
}

const EDIT_MARK = `<sup style="color:#b45309;font-weight:800;">*</sup>`;

function holidayOn(ctx: SheetContext, iso: string): string | null {
  return ctx.holidays?.find((holiday) => iso >= holiday.startDate && iso <= holiday.endDate)?.name ?? null;
}

// The changes made during review (each with the value it replaced and the
// reason) and the unpaid-leave deductions, under the sheet.
function sheetNotes(entries: AllowanceEntry[], ctx: SheetContext): string {
  const { t, languageCode } = ctx;
  const edits = entries.flatMap((entry) =>
    Object.entries(entry.manualOverrides).map(([line, change]) => ({ date: entry.entryDate, line, ...change })),
  );
  const deductions = ctx.deductions ?? [];
  if (edits.length === 0 && deductions.length === 0) return "";
  const editRows = edits
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((edit) => `<tr>${cell(shortDate(edit.date))}${cell(escapeHtml(t(`sheetEdit.line.${edit.line}`)))}${cell(moneyAlways(edit.original, languageCode))}${cell(moneyAlways(edit.value, languageCode))}${cell(escapeHtml(edit.reason ?? "—"), "text-align:start;")}</tr>`)
    .join("");
  const deductionTotal = deductions.reduce((sum, row) => sum + row.amount, 0);
  return `
    ${
      edits.length
        ? `<div style="margin-top:16px;font-size:12px;font-weight:800;">${EDIT_MARK} ${escapeHtml(t("sheet.editsTitle"))}</div>
    <table style="width:100%;margin-top:6px;border-collapse:collapse;font-size:10.5px;">
      <thead><tr>${[t("sheet.date"), t("sheet.line"), t("sheet.before"), t("sheet.after"), t("sheet.reason")].map(head).join("")}</tr></thead>
      <tbody>${editRows}</tbody>
    </table>`
        : ""
    }
    ${
      deductions.length
        ? `<div style="margin-top:14px;font-size:12px;font-weight:800;">${escapeHtml(t("sheet.deductionsTitle"))}</div>
    <div style="font-size:10.5px;color:#475569;margin-top:2px;">${escapeHtml(t("sheet.deductionsNote"))}</div>
    <table style="width:60%;margin-top:6px;border-collapse:collapse;font-size:10.5px;">
      <thead><tr>${[t("sheet.date"), t("sheet.amount")].map(head).join("")}</tr></thead>
      <tbody>
        ${deductions.map((row) => `<tr>${cell(shortDate(row.workDate))}${cell(`${moneyAlways(row.amount, languageCode)} ${escapeHtml(row.currency)}`)}</tr>`).join("")}
        <tr style="font-weight:800;">${cell(escapeHtml(t("sheet.total")))}${cell(`${moneyAlways(deductionTotal, languageCode)} ${escapeHtml(deductions[0].currency)}`)}</tr>
      </tbody>
    </table>`
        : ""
    }`;
}

/** A manager's combined sheet: one line of totals per chosen employee. */
export function buildCombinedAllowanceSheetPdf(entries: AllowanceEntry[], ctx: SheetContext): Promise<jsPDF> {
  const { t, languageCode, startDate, endDate } = ctx;
  const isRtl = languageCode === "ar";
  const people = new Map<string, AllowanceEntry[]>();
  for (const entry of entries) people.set(entry.userFullName, [...(people.get(entry.userFullName) ?? []), entry]);
  const collator = new Intl.Collator(languageCode, { sensitivity: "base" });
  const names = [...people.keys()].sort(collator.compare);

  const fields: [string, (entry: AllowanceEntry) => number][] = [
    [t("prices.field.expatriation"), (e) => e.expatriationAllowance],
    [t("prices.field.transportation"), (e) => e.transportationAllowance],
    [t("prices.field.travel"), (e) => e.travelAllowance],
    [t("prices.field.meal"), (e) => e.mealAllowance],
    [t("prices.field.housing"), (e) => e.housingAllowance],
    [t("prices.field.other"), (e) => e.otherAllowance],
    [t("sheet.extraDaysValue"), (e) => e.extraDaysAmount],
    [t("sheet.overtimeValue"), (e) => e.overtimeAmount],
  ];
  const used = fields.filter(([, pick]) => entries.some((entry) => pick(entry) > 0));

  const rows = names
    .map((name, index) => {
      const list = people.get(name) ?? [];
      const days = list.filter((entry) => entry.clockInAt).length;
      const total = list.reduce((sum, entry) => sum + allowanceSum(entry) + extraSum(entry), 0);
      return `<tr>${cell(String(index + 1))}${cell(escapeHtml(name), "text-align:start;")}${cell(String(days))}${used
        .map(([, pick]) => cell(moneyAlways(list.reduce((sum, entry) => sum + pick(entry), 0), languageCode)))
        .join("")}${cell(`<strong>${moneyAlways(total, languageCode)}</strong>`)}</tr>`;
    })
    .join("");
  const grand = entries.reduce((sum, entry) => sum + allowanceSum(entry) + extraSum(entry), 0);
  const totalsRow = `<tr style="font-weight:800;background:#eef2f7;">${cell("")}${cell(escapeHtml(t("sheet.total")))}${cell(String(entries.filter((entry) => entry.clockInAt).length))}${used
    .map(([, pick]) => cell(moneyAlways(entries.reduce((sum, entry) => sum + pick(entry), 0), languageCode)))
    .join("")}${cell(moneyAlways(grand, languageCode))}</tr>`;

  const container = document.createElement("div");
  container.dir = isRtl ? "rtl" : "ltr";
  container.style.cssText = "width:900px;padding:30px 34px;background:#ffffff;color:#0f172a;font-family:'IBM Plex Sans Arabic','Segoe UI',Tahoma,Arial,sans-serif;";
  container.innerHTML = `
    ${header(ctx, t("sheet.combinedSubtitle"))}
    <div style="display:flex;justify-content:space-between;gap:16px;font-size:14px;font-weight:800;margin-bottom:10px;">
      <div>${escapeHtml(t("sheet.employeesCount", { count: names.length }))}</div>
      <div>${escapeHtml(t("sheet.periodFrom"))} : ${longDate(startDate)} &nbsp; ${escapeHtml(t("sheet.periodTo"))} : ${longDate(endDate)}</div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:11px;">
      <thead><tr>${["#", t("sheet.employee"), t("sheet.days"), ...used.map(([label]) => label), t("sheet.total")].map(head).join("")}</tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>${totalsRow}</tfoot>
    </table>
    <div style="margin-top:12px;padding:10px;border-radius:6px;background:${BRAND};color:#ffffff;text-align:center;">
      <div style="font-size:12px;opacity:0.9;">${escapeHtml(t("sheet.grandTotal"))}</div>
      <div style="font-size:20px;font-weight:800;">${moneyAlways(grand, languageCode)}</div>
    </div>
    ${footer(ctx)}
  `;
  return renderHtmlToPdf(container);
}
