import type { jsPDF } from "jspdf";
import type { TFunction } from "i18next";

import { renderHtmlToPdf, escapeHtml } from "../../core/utils/htmlToPdf";
import { toXlsx, type Cell } from "../../core/utils/spreadsheet";
import { amountInWords, currencyLabel } from "../../core/utils/amountInWords";
import type { CycleEmployee, CycleLine, PayrollReport } from "../../core/repositories/PayrollCycleRepository";

// 2026-11-08/09: the three payroll reports as files, laid out like the owner's reference images
// (PROSM Time | the organisation | the title or the issue; an information strip; grouped columns;
// the net highlighted; a navy total row; issue date and time, signatures and notes). The server
// already chose which lines each report may show (payslip and summary: only lines in the net;
// combined: basic + allowances), so these builders never filter or recalculate - they lay out
// what the report returned. Totals are per currency, never summed across currencies.

const money = (value: number | string) => Number(value ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NAVY = "#13294b";
const INK = "#18213a";
const MUTED = "#5b667a";
const RULE = "#c9d1dc";
const BAND = "#dbe7f3";
const SOFT = "#eff4f9";
const NET = "#fdf3dc";
// isolate a left-to-right run (a version and serial) inside an Arabic line
const LRI = String.fromCharCode(0x2066);
const PDI = String.fromCharCode(0x2069);

type T = TFunction;
const lineName = (line: CycleLine, isRtl: boolean) => (isRtl ? line.name_ar : line.name_en || line.name_ar);
const earningLines = (e: CycleEmployee) => e.lines.filter((l) => l.category === "earning" || l.category === "allowance");
const en = (t: T, key: string) => t(key, { lng: "en" });
const pad = (n: number) => String(n).padStart(2, "0");
function issuedNow() {
  const d = new Date();
  return { date: `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` };
}
/** A label with its English line under it on an Arabic document. */
const bi = (t: T, key: string, isRtl: boolean, size = 10) =>
  `${escapeHtml(t(key))}${isRtl ? `<div style="font-size:${size}px;font-weight:400;opacity:.85;">${escapeHtml(en(t, key))}</div>` : ""}`;

function brand(): string {
  return `<div dir="ltr" style="text-align:center;min-width:170px;">
      <div style="font:italic 800 30px 'Segoe UI',Arial,sans-serif;color:${NAVY};letter-spacing:-.5px;line-height:1;">PROSM Time</div>
      <div style="font:600 9px 'Segoe UI',Arial,sans-serif;color:${INK};letter-spacing:4px;margin-top:6px;">WORK, TRACKED.</div>
    </div>`;
}

function organization(report: PayrollReport): string {
  return `<div style="flex:1;text-align:center;">
      ${report.organization.logoUrl ? `<img src="${escapeHtml(report.organization.logoUrl)}" style="height:44px;max-width:180px;object-fit:contain;display:block;margin:0 auto 4px;" />` : ""}
      <div style="font-size:16px;font-weight:700;color:${INK};">${escapeHtml(report.organization.name)}</div>
    </div>`;
}

const divider = `<div style="width:1px;align-self:stretch;background:${RULE};margin:0 18px;"></div>`;

function draftBanner(report: PayrollReport, t: T): string {
  return report.draft ? `<div style="border:1.5px dashed #b45309;color:#b45309;text-align:center;padding:6px;margin:10px 0;font-weight:700;">${escapeHtml(t("payroll:doc.draft"))}</div>` : "";
}

function versionLine(report: PayrollReport, t: T): string {
  const parts = [
    report.serial ? `${t("payroll:doc.serial")}: ${report.serial}` : null,
    report.cycle.cycleVersion > 0 ? `${t("payroll:doc.version")}: v${report.cycle.cycleVersion}${report.cycle.cycleVersion > 1 ? ` · ${t("payroll:doc.amended")}` : ""}` : null,
  ].filter(Boolean);
  return parts.length ? `<div style="font-size:10px;color:${MUTED};">${parts.map((p) => escapeHtml(String(p))).join(" &nbsp;·&nbsp; ")}</div>` : "";
}

function notesLine(report: PayrollReport): string {
  const notes = [report.settings.taxNotice, report.settings.footerNote].filter(Boolean).map((n) => `<div>${escapeHtml(String(n))}</div>`).join("");
  return `<div style="margin-top:14px;border-top:1px solid ${RULE};padding-top:6px;font-size:9.5px;color:${MUTED};text-align:center;">${notes}<div dir="ltr">PROSM Time · Work, Tracked.</div></div>`;
}

// ---- the payslip -------------------------------------------------------------------------------
/** Exported for previews and tests; the PDF builders below use it. */
export function payslipHtml(report: PayrollReport, e: CycleEmployee, t: T, isRtl: boolean, issued: { date: string; time: string }): string {
  const site = (e.site_id && report.siteNames?.[e.site_id]) || report.cycle.siteName || "-";
  const meta = [["payroll:doc.issued", issued.date], ["payroll:doc.issueTime", issued.time], ["payroll:doc.pages", "1"]]
    .map(([k, v]) => `<div style="display:flex;justify-content:space-between;gap:14px;"><b>${escapeHtml(t(k))} :</b><span dir="ltr">${escapeHtml(v)}</span></div>`).join("");
  const column = (titleKey: string, totalKey: string, lines: CycleLine[], total: number, rows: number) => {
    const body = lines.map((l) => `<tr><td style="padding:5px 8px;border-bottom:1px solid ${RULE};border-inline-end:1px solid ${RULE};">${escapeHtml(lineName(l, isRtl))}</td><td style="padding:5px 8px;border-bottom:1px solid ${RULE};text-align:center;white-space:nowrap;"><span dir="ltr">${money(l.amount)}</span></td></tr>`).join("");
    const filler = Array.from({ length: Math.max(0, rows - lines.length) }, () => `<tr><td style="padding:5px 8px;border-inline-end:1px solid ${RULE};">&nbsp;</td><td></td></tr>`).join("");
    return `<div style="flex:1;border:1px solid ${RULE};border-radius:6px;display:flex;flex-direction:column;overflow:hidden;">
        <div style="background:${BAND};text-align:center;font-weight:700;font-size:15px;padding:7px;">${escapeHtml(t(titleKey))}</div>
        <table style="width:100%;border-collapse:collapse;font-size:12px;flex:1;">
          <thead><tr style="background:${SOFT};"><th style="padding:5px 8px;text-align:center;width:62%;">${escapeHtml(t("payroll:doc.item"))}</th><th style="padding:5px 8px;text-align:center;">${escapeHtml(t("payroll:doc.value"))}</th></tr></thead>
          <tbody>${body}${filler}</tbody>
        </table>
        <div style="display:flex;justify-content:space-between;background:${SOFT};margin:6px;padding:7px 10px;border-radius:4px;font-weight:700;"><span>${escapeHtml(t(totalKey))}</span><span dir="ltr">${money(total)}</span></div>
      </div>`;
  };
  const earnings = earningLines(e);
  const deductions = e.lines.filter((l) => l.category === "deduction");
  const installments = e.lines.filter((l) => l.category === "installment");
  const rows = Math.max(5, earnings.length, deductions.length, installments.length);
  const [curName, curCode] = currencyLabel(e.currency);
  const words = amountInWords(e.net_salary, e.currency, isRtl ? "ar" : "en");
  return `
    <div style="display:flex;align-items:center;gap:12px;">
      <div style="min-width:170px;font-size:11.5px;color:${INK};line-height:1.8;">${meta}</div>
      ${organization(report)}${divider}${brand()}
    </div>
    <div style="background:${BAND};border-radius:6px;text-align:center;padding:8px;margin-top:14px;">
      <div style="font-size:26px;font-weight:800;color:${INK};">${escapeHtml(t("payroll:doc.payslipTitle"))}</div>
      ${isRtl ? `<div style="font-size:14px;color:${INK};">${escapeHtml(en(t, "payroll:doc.payslipTitle"))}</div>` : ""}
    </div>
    ${draftBanner(report, t)}
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-bottom:1.5px solid ${NAVY};font-size:13px;">
      <span><b>${escapeHtml(t("payroll:doc.month"))} :</b> &nbsp; ${escapeHtml(report.cycle.title)}</span>
      <span dir="ltr" style="color:${MUTED};font-size:11px;">${escapeHtml(report.cycle.periodStart)} - ${escapeHtml(report.cycle.periodEnd)}</span>
    </div>
    <div style="display:flex;border:1px solid ${RULE};border-radius:6px;margin:14px 0;text-align:center;">
      ${[["payroll:doc.code", e.employee_code ?? "-", "22%"], ["payroll:doc.employee", e.full_name, "45%"], ["payroll:doc.siteDept", site, "33%"]]
        .map(([k, v, w], i) => `<div style="width:${w};padding:8px;${i ? `border-inline-start:1px solid ${RULE};` : ""}"><div style="font-weight:700;font-size:12px;">${escapeHtml(t(k))}</div><div style="font-weight:800;font-size:16px;margin-top:3px;">${escapeHtml(v)}</div></div>`).join("")}
    </div>
    <div style="display:flex;gap:12px;align-items:stretch;">
      ${column("payroll:doc.earnings", "payroll:doc.totalEarnings", earnings, e.total_earnings, rows)}
      ${column("payroll:doc.deductions", "payroll:doc.totalDeductions", deductions, e.total_deductions, rows)}
      ${column("payroll:doc.installments", "payroll:doc.totalInstallments", installments, e.total_installments, rows)}
    </div>
    <div style="display:flex;align-items:stretch;background:${SOFT};border-radius:6px;margin-top:14px;overflow:hidden;">
      <div style="background:${NAVY};color:#fff;min-width:150px;padding:8px 14px;text-align:center;font-size:18px;font-weight:700;display:flex;flex-direction:column;justify-content:center;">${bi(t, "payroll:doc.net", isRtl, 11)}</div>
      <div style="padding:0 18px;font-size:30px;font-weight:800;display:flex;align-items:center;"><span dir="ltr">${money(e.net_salary)}</span></div>
      <div style="text-align:center;display:flex;flex-direction:column;justify-content:center;font-size:14px;font-weight:700;">${isRtl ? `<div>${escapeHtml(curName)}</div>` : ""}<div style="font-size:11px;font-weight:400;">${escapeHtml(curCode)}</div></div>
      <div style="width:1px;background:${RULE};margin:10px 16px;"></div>
      <div style="flex:1;display:flex;align-items:center;font-size:13px;padding-inline-end:12px;">${escapeHtml(words)}</div>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:flex-start;border-top:1.5px solid ${NAVY};margin-top:16px;padding-top:10px;">
      ${versionLine(report, t)}
      <div style="text-align:center;min-width:200px;"><b style="font-size:13px;">${escapeHtml(t("payroll:doc.managementApproval"))}</b><div style="border-bottom:1.5px dotted ${MUTED};height:28px;"></div></div>
    </div>
    ${notesLine(report)}`;
}

function container(isRtl: boolean, width: number): HTMLDivElement {
  const el = document.createElement("div");
  el.dir = isRtl ? "rtl" : "ltr";
  el.style.cssText = `width:${width}px;padding:28px;background:#ffffff;color:${INK};font-family:'IBM Plex Sans Arabic','Segoe UI',Tahoma,Arial,sans-serif;`;
  return el;
}

/** One payslip per page, in one PDF. */
export async function buildPayslipsPdf(report: PayrollReport, t: T, isRtl: boolean): Promise<jsPDF | null> {
  let doc: jsPDF | null = null;
  const issued = issuedNow();
  for (const [index, e] of report.employees.entries()) {
    const el = container(isRtl, 800);
    el.innerHTML = payslipHtml(report, e, t, isRtl, issued);
    doc = await renderHtmlToPdf(el, { doc: doc ?? undefined, numberPages: index === report.employees.length - 1 });
  }
  return doc;
}

/** The payslip of one person (My payslips), from the stored version. */
export async function buildOnePayslipPdf(report: PayrollReport, t: T, isRtl: boolean): Promise<jsPDF> {
  const el = container(isRtl, 800);
  el.innerHTML = payslipHtml(report, report.employees[0], t, isRtl, issuedNow());
  return renderHtmlToPdf(el);
}

// ---- the summary and combined tables -----------------------------------------------------------
function columnsOf(report: PayrollReport, categories: CycleLine["category"][], isRtl: boolean): string[] {
  const seen = new Map<string, number>();
  for (const e of report.employees)
    for (const l of e.lines) if (categories.includes(l.category) && !seen.has(lineName(l, isRtl))) seen.set(lineName(l, isRtl), l.sort_order);
  return [...seen.entries()].sort((a, b) => a[1] - b[1]).map(([name]) => name);
}
const amountIn = (e: CycleEmployee, name: string, categories: CycleLine["category"][], isRtl: boolean) =>
  e.lines.filter((l) => categories.includes(l.category) && lineName(l, isRtl) === name).reduce((sum, l) => sum + Number(l.amount), 0);

interface Table {
  head: string[];
  rows: Cell[][];
  totals: Cell[][];
}

function summaryTable(report: PayrollReport, t: T, isRtl: boolean): Table & { earn: string[]; ded: string[]; multi: boolean } {
  const earn = columnsOf(report, ["earning", "allowance"], isRtl);
  const ded = columnsOf(report, ["deduction"], isRtl);
  const multi = report.totals.length > 1;
  const head = [t("payroll:doc.no"), t("payroll:doc.code"), t("payroll:doc.employee"), ...earn, t("payroll:doc.totalEarnings"), ...ded, t("payroll:doc.totalDeductions"),
    t("payroll:doc.totalInstallments"), t("payroll:doc.net"), t("payroll:doc.currency")];
  const rows = report.employees.map((e, i) => [String(i + 1), e.employee_code ?? "", e.full_name,
    ...earn.map((n) => amountIn(e, n, ["earning", "allowance"], isRtl)), Number(e.total_earnings),
    ...ded.map((n) => amountIn(e, n, ["deduction"], isRtl)), Number(e.total_deductions), Number(e.total_installments), Number(e.net_salary), e.currency]);
  const totals = report.totals.map((total) => ["", "", multi ? `${t("payroll:doc.total")} (${total.currency})` : t("payroll:doc.total"),
    ...earn.map((n) => report.employees.filter((e) => e.currency === total.currency).reduce((s, e) => s + amountIn(e, n, ["earning", "allowance"], isRtl), 0)),
    Number(total.earnings),
    ...ded.map((n) => report.employees.filter((e) => e.currency === total.currency).reduce((s, e) => s + amountIn(e, n, ["deduction"], isRtl), 0)),
    Number(total.deductions), Number(total.installments), Number(total.net), total.currency]);
  return { head, rows, totals, earn, ded, multi };
}

function combinedTable(report: PayrollReport, t: T): Table & { multi: boolean } {
  const multi = report.totals.length > 1;
  const head = [t("payroll:doc.no"), t("payroll:doc.employee"), t("payroll:doc.code"), t("payroll:doc.combinedTotal"), t("payroll:doc.currency")];
  const rows = report.employees.map((e, i) => [String(i + 1), e.full_name, e.employee_code ?? "", Number(e.combined_total), e.currency]);
  const totals = report.totals.map((total) => ["", multi ? `${t("payroll:doc.totalSalaries")} (${total.currency})` : t("payroll:doc.totalSalaries"), "", Number(total.combined), total.currency]);
  return { head, rows, totals, multi };
}

function reportHeader(report: PayrollReport, t: T, isRtl: boolean, titleKey: string): string {
  return `<div style="display:flex;align-items:center;gap:12px;">
      <div style="min-width:260px;">
        <div style="font-size:24px;font-weight:800;color:${INK};">${escapeHtml(t(titleKey))}</div>
        ${isRtl ? `<div style="font-size:15px;color:${INK};">${escapeHtml(en(t, titleKey))}</div>` : ""}
      </div>
      ${organization(report)}${divider}${brand()}
    </div>`;
}

function infoStrip(report: PayrollReport, t: T, isRtl: boolean): string {
  const cells: [string, string][] = [
    ["payroll:doc.employees", String(report.employees.length)],
    ["payroll:doc.site", report.cycle.siteName ?? t("payroll:doc.allSites")],
    ["payroll:doc.version", report.cycle.cycleVersion > 0 ? `${LRI}v${report.cycle.cycleVersion}${report.serial ? ` · #${report.serial}` : ""}${PDI}` : "-"],
    ["payroll:doc.month", report.cycle.title],
  ];
  return `<div style="display:flex;background:${SOFT};border-radius:8px;margin:14px 0 12px;padding:8px 0;">
      ${cells.map(([k, v], i) => `<div style="flex:1;text-align:center;${i ? `border-inline-start:1px solid ${RULE};` : ""}">
        <div style="font-size:13px;"><b>${escapeHtml(t(k))} :</b> &nbsp;${escapeHtml(v)}</div>
        ${isRtl ? `<div style="font-size:10.5px;color:${MUTED};">${escapeHtml(en(t, k))} : ${escapeHtml(k === "payroll:doc.site" && !report.cycle.siteName ? en(t, "payroll:doc.allSites") : v)}</div>` : ""}
      </div>`).join("")}
    </div>`;
}

export function reportFooter(report: PayrollReport, t: T, isRtl: boolean, issued: { date: string; time: string }): string {
  const signatures = report.settings.showSignatures
    ? ["approved", "reviewed", "prepared"].map((k) => `<div style="flex:1;text-align:center;padding:0 10px;${`border-inline-start:1px solid ${RULE};`}"><b style="font-size:12.5px;">${bi(t, `payroll:doc.${k}`, isRtl, 10)}</b><div style="border-bottom:1.5px dotted ${MUTED};height:24px;margin:0 14px;"></div></div>`).join("")
    : "";
  return `<div style="display:flex;align-items:stretch;margin-top:18px;border-top:1px solid ${RULE};padding-top:10px;font-size:12px;">
      <div style="min-width:200px;line-height:1.8;">
        <div><b>${escapeHtml(t("payroll:doc.issued"))} :</b> <span dir="ltr">${issued.date}</span></div>
        <div><b>${escapeHtml(t("payroll:doc.issueTime"))} :</b> <span dir="ltr">${issued.time}</span></div>
      </div>
      ${signatures}
      <div style="min-width:220px;padding-inline-start:14px;border-inline-start:1px solid ${RULE};"><b>${escapeHtml(t("payroll:doc.notes"))} :</b><div style="border-bottom:1.5px dotted ${MUTED};height:24px;"></div></div>
    </div>
    ${versionLine(report, t)}
    ${notesLine(report)}`;
}

const td = (value: Cell, isRtl: boolean, extra = "") =>
  `<td style="padding:5px 6px;border:1px solid ${RULE};${typeof value === "number" ? `text-align:${isRtl ? "left" : "right"};white-space:nowrap;` : ""}${extra}">${typeof value === "number" ? `<span dir="ltr">${money(value)}</span>` : escapeHtml(value)}</td>`;
const th = (text: string, extra = "") => `<th style="padding:6px;border:1px solid #2b416a;${extra}">${text}</th>`;

export function summaryHtml(report: PayrollReport, t: T, isRtl: boolean): string {
  const table = summaryTable(report, t, isRtl);
  const cur = table.multi ? "" : ` (${escapeHtml(report.totals[0]?.currency ?? "")})`;
  const sub = (key: string) => (isRtl ? `<div style="font-weight:400;font-size:9px;opacity:.85;">${escapeHtml(en(t, key))}</div>` : "");
  const head1 = [
    th(`${escapeHtml(t("payroll:doc.no"))}${sub("payroll:doc.no")}`, "", ),
    th(`${escapeHtml(t("payroll:doc.code"))}${sub("payroll:doc.code")}`),
    th(`${escapeHtml(t("payroll:doc.employee"))}${sub("payroll:doc.employee")}`),
    `<th colspan="${table.earn.length + 1}" style="padding:6px;border:1px solid #2b416a;">${escapeHtml(t("payroll:doc.earnings"))}${cur}${sub("payroll:doc.earnings")}</th>`,
    `<th colspan="${table.ded.length + 1}" style="padding:6px;border:1px solid #2b416a;">${escapeHtml(t("payroll:doc.deductions"))}${cur}${sub("payroll:doc.deductions")}</th>`,
    th(`${escapeHtml(t("payroll:doc.installments"))}${cur}${sub("payroll:doc.installments")}`),
    th(`${escapeHtml(t("payroll:doc.net"))}${cur}${sub("payroll:doc.net")}`, "font-size:13px;"),
    ...(table.multi ? [th(escapeHtml(t("payroll:doc.currency")))] : []),
  ];
  const head2 = [
    ...table.earn.map((n) => th(escapeHtml(n), "font-weight:500;")), th(escapeHtml(t("payroll:doc.totalEarnings")), "font-weight:500;"),
    ...table.ded.map((n) => th(escapeHtml(n), "font-weight:500;")), th(escapeHtml(t("payroll:doc.totalDeductions")), "font-weight:500;"),
    th(escapeHtml(t("payroll:doc.totalInstallments")), "font-weight:500;"),
  ];
  const rowspan = (html: string) => html.replace("<th ", '<th rowspan="2" ');
  const earnEnd = 3 + table.earn.length; // index of the total earnings column
  const dedEnd = earnEnd + 1 + table.ded.length;
  const netIndex = dedEnd + 2;
  const bodyRow = (r: Cell[], total = false) => {
    const cells = table.multi ? r : r.slice(0, -1);
    return `<tr style="${total ? `background:${NAVY};color:#fff;font-weight:700;` : ""}">${cells.map((c, i) => {
      const bold = i === earnEnd || i === dedEnd ? "font-weight:700;" : "";
      const net = i === netIndex ? (total ? "font-size:14px;" : `background:${NET};font-weight:800;font-size:13px;`) : "";
      return td(c, isRtl, `${bold}${net}${total ? "border-color:#2b416a;" : ""}`);
    }).join("")}</tr>`;
  };
  return `${reportHeader(report, t, isRtl, "payroll:doc.summaryTitle")}
    ${draftBanner(report, t)}
    ${infoStrip(report, t, isRtl)}
    <table style="width:100%;border-collapse:collapse;font-size:11px;">
      <thead style="background:${NAVY};color:#fff;"><tr>${[head1[0], head1[1], head1[2]].map(rowspan).join("")}${head1[3]}${head1[4]}${head1[5]}${rowspan(head1[6])}${table.multi ? rowspan(head1[7]) : ""}</tr><tr>${head2.join("")}</tr></thead>
      <tbody>${table.rows.map((r) => bodyRow(r)).join("")}${table.totals.map((r) => bodyRow(r, true)).join("")}</tbody>
    </table>`;
}

export function combinedHtml(report: PayrollReport, t: T, isRtl: boolean): string {
  const table = combinedTable(report, t);
  const cells = (r: Cell[]) => (table.multi ? r : r.slice(0, -1));
  return `${reportHeader(report, t, isRtl, "payroll:doc.combinedTitle")}
    ${draftBanner(report, t)}
    ${infoStrip(report, t, isRtl)}
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead style="background:${NAVY};color:#fff;"><tr>${cells(table.head).map((h) => th(escapeHtml(String(h)))).join("")}</tr></thead>
      <tbody>${table.rows.map((r) => `<tr>${cells(r).map((c, i) => td(c, isRtl, i === 3 ? "font-weight:800;" : "")).join("")}</tr>`).join("")}
      ${table.totals.map((r) => `<tr style="background:${NAVY};color:#fff;font-weight:700;">${cells(r).map((c) => td(c, isRtl, "border-color:#2b416a;font-size:15px;")).join("")}</tr>`).join("")}</tbody>
    </table>
    <div style="margin-top:8px;font-size:11px;color:${MUTED};">${escapeHtml(t("payroll:doc.combinedNotNet"))}</div>`;
}

export async function buildSummaryPdf(report: PayrollReport, t: T, isRtl: boolean, combined: boolean): Promise<jsPDF> {
  const el = container(isRtl, 1180);
  el.innerHTML = `${combined ? combinedHtml(report, t, isRtl) : summaryHtml(report, t, isRtl)}${reportFooter(report, t, isRtl, issuedNow())}`;
  return renderHtmlToPdf(el, { landscape: true });
}

export function buildReportXlsx(report: PayrollReport, t: T, isRtl: boolean, combined: boolean): Uint8Array {
  const table = combined ? combinedTable(report, t) : summaryTable(report, t, isRtl);
  return toXlsx([table.head, ...table.rows, ...table.totals], isRtl, { freezeHeader: true, autoFilter: true, sheetName: t(combined ? "payroll:reports.combined" : "payroll:reports.summary") });
}
