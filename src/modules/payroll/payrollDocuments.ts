import type { jsPDF } from "jspdf";
import type { TFunction } from "i18next";

import { renderHtmlToPdf, escapeHtml } from "../../core/utils/htmlToPdf";
import { toXlsx, type Cell } from "../../core/utils/spreadsheet";
import type { CycleEmployee, CycleLine, PayrollReport } from "../../core/repositories/PayrollCycleRepository";
import prosmLogo from "../../assets/prosm-logo-pdf.png";

// 2026-11-08: the three payroll reports as files. The server already chose which lines each
// report may show (payslip and summary: only lines in the net; combined: basic + allowances),
// so these builders never filter or recalculate - they lay out what the report returned.
// Totals are per currency, never summed across currencies.

const money = (value: number | string) => Number(value ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NAVY = "#10284f";
const RULE = "#dbe2ec";
const BAND = "#eef3f9";

type T = TFunction;
const lineName = (line: CycleLine, isRtl: boolean) => (isRtl ? line.name_ar : line.name_en || line.name_ar);
const earningLines = (e: CycleEmployee) => e.lines.filter((l) => l.category === "earning" || l.category === "allowance");

function header(report: PayrollReport, t: T, title: string): string {
  const meta = [
    `${t("payroll:doc.period")}: ${report.cycle.title} (${report.cycle.periodStart} - ${report.cycle.periodEnd})`,
    report.cycle.siteName ? `${t("payroll:doc.site")}: ${report.cycle.siteName}` : t("payroll:doc.wholeOrganization"),
    report.serial ? `${t("payroll:doc.serial")}: ${report.serial}` : null,
    report.cycle.cycleVersion > 0 ? `${t("payroll:doc.version")}: v${report.cycle.cycleVersion}${report.cycle.cycleVersion > 1 ? ` · ${t("payroll:doc.amended")}` : ""}` : null,
    `${t("payroll:doc.issued")}: ${new Date().toISOString().slice(0, 10)}`,
  ].filter(Boolean);
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid ${RULE};padding-bottom:12px;margin-bottom:14px;">
      ${report.organization.logoUrl ? `<img src="${escapeHtml(report.organization.logoUrl)}" style="height:46px;max-width:120px;object-fit:contain;" />` : `<div style="font-weight:700;font-size:16px;color:${NAVY};">${escapeHtml(report.organization.name)}</div>`}
      <div style="text-align:center;flex:1;">
        <div style="font-size:20px;font-weight:700;color:${NAVY};">${escapeHtml(title)}</div>
        ${report.organization.logoUrl ? `<div style="font-size:12px;color:#475569;">${escapeHtml(report.organization.name)}</div>` : ""}
      </div>
      <img src="${prosmLogo}" style="height:34px;width:34px;object-fit:contain;opacity:.85;" />
    </div>
    ${report.draft ? `<div style="border:1px dashed #b45309;color:#b45309;text-align:center;padding:6px;margin-bottom:10px;font-weight:700;">${escapeHtml(t("payroll:doc.draft"))}</div>` : ""}
    <div style="display:flex;flex-wrap:wrap;gap:6px 18px;font-size:11px;color:#475569;margin-bottom:12px;">${meta.map((m) => `<span>${escapeHtml(String(m))}</span>`).join("")}</div>`;
}

function footer(report: PayrollReport, t: T): string {
  const signatures = report.settings.showSignatures
    ? `<div style="display:flex;gap:24px;margin-top:22px;">${["prepared", "reviewed", "approved"]
        .map((k) => `<div style="flex:1;font-size:11px;color:#475569;">${escapeHtml(t(`payroll:doc.${k}`))}<div style="border-bottom:1px dotted #94a3b8;height:22px;"></div></div>`)
        .join("")}</div>`
    : "";
  const notes = [report.settings.taxNotice, report.settings.footerNote].filter(Boolean).map((n) => `<div>${escapeHtml(String(n))}</div>`).join("");
  return `${signatures}<div style="margin-top:16px;border-top:1px solid ${RULE};padding-top:8px;font-size:10px;color:#64748b;text-align:center;">${notes}<div>PROSM Time · Work, Tracked.</div></div>`;
}

function container(isRtl: boolean, width: number): HTMLDivElement {
  const el = document.createElement("div");
  el.dir = isRtl ? "rtl" : "ltr";
  el.style.cssText = `width:${width}px;padding:28px;background:#ffffff;color:#0f172a;font-family:'IBM Plex Sans Arabic','Segoe UI',Tahoma,Arial,sans-serif;`;
  return el;
}

function payslipHtml(report: PayrollReport, e: CycleEmployee, t: T, isRtl: boolean): string {
  const block = (titleKey: string, totalKey: string, lines: CycleLine[], total: number) => `
    <table style="width:100%;border-collapse:collapse;border:1px solid ${RULE};margin-bottom:10px;font-size:12px;">
      <thead><tr style="background:${BAND};"><th colspan="2" style="padding:6px;text-align:center;color:${NAVY};">${escapeHtml(t(titleKey))}</th></tr></thead>
      <tbody>
        ${lines.length === 0 ? `<tr><td colspan="2" style="padding:6px 10px;color:#94a3b8;">${escapeHtml(t("payroll:doc.none"))}</td></tr>` : lines
          .map((l) => `<tr><td style="padding:5px 10px;border-top:1px solid ${RULE};">${escapeHtml(lineName(l, isRtl))}</td><td style="padding:5px 10px;border-top:1px solid ${RULE};text-align:${isRtl ? "left" : "right"};white-space:nowrap;">${money(l.amount)}</td></tr>`)
          .join("")}
        <tr style="font-weight:700;color:${NAVY};"><td style="padding:6px 10px;border-top:1px solid ${RULE};">${escapeHtml(t(totalKey))}</td><td style="padding:6px 10px;border-top:1px solid ${RULE};text-align:${isRtl ? "left" : "right"};">${money(total)}</td></tr>
      </tbody>
    </table>`;
  return `
    ${header(report, t, t("payroll:reports.payslip"))}
    <table style="width:100%;border-collapse:collapse;border:1px solid ${RULE};margin-bottom:12px;font-size:12px;"><tr>
      <td style="padding:8px;text-align:center;"><div style="color:#64748b;font-size:10px;">${escapeHtml(t("payroll:doc.employee"))}</div><b>${escapeHtml(e.full_name)}</b></td>
      <td style="padding:8px;text-align:center;border-inline-start:1px solid ${RULE};"><div style="color:#64748b;font-size:10px;">${escapeHtml(t("payroll:doc.code"))}</div><b>${escapeHtml(e.employee_code ?? "-")}</b></td>
    </tr></table>
    ${block("payroll:doc.earnings", "payroll:doc.totalEarnings", earningLines(e), e.total_earnings)}
    ${block("payroll:doc.deductions", "payroll:doc.totalDeductions", e.lines.filter((l) => l.category === "deduction"), e.total_deductions)}
    ${block("payroll:doc.installments", "payroll:doc.totalInstallments", e.lines.filter((l) => l.category === "installment"), e.total_installments)}
    <div style="display:flex;justify-content:space-between;align-items:center;background:${NAVY};color:#fff;padding:12px 16px;font-size:16px;font-weight:700;">
      <span>${escapeHtml(t("payroll:doc.net"))}</span><span>${money(e.net_salary)} ${escapeHtml(e.currency)}</span>
    </div>
    ${footer(report, t)}`;
}

/** One payslip per page, in one PDF. */
export async function buildPayslipsPdf(report: PayrollReport, t: T, isRtl: boolean): Promise<jsPDF | null> {
  let doc: jsPDF | null = null;
  for (const [index, e] of report.employees.entries()) {
    const el = container(isRtl, 640);
    el.innerHTML = payslipHtml(report, e, t, isRtl);
    doc = await renderHtmlToPdf(el, { doc: doc ?? undefined, numberPages: index === report.employees.length - 1 });
  }
  return doc;
}

/** The payslip of one person (My payslips), from the stored version. */
export async function buildOnePayslipPdf(report: PayrollReport, t: T, isRtl: boolean): Promise<jsPDF> {
  const el = container(isRtl, 640);
  el.innerHTML = payslipHtml(report, report.employees[0], t, isRtl);
  return renderHtmlToPdf(el);
}

// The summary and combined tables: one column per line name the report contains, in order.
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

function summaryTable(report: PayrollReport, t: T, isRtl: boolean): Table {
  const earn = columnsOf(report, ["earning", "allowance"], isRtl);
  const ded = columnsOf(report, ["deduction"], isRtl);
  const head = ["#", t("payroll:doc.code"), t("payroll:doc.employee"), ...earn, t("payroll:doc.totalEarnings"), ...ded, t("payroll:doc.totalDeductions"),
    t("payroll:doc.totalInstallments"), t("payroll:doc.net"), t("payroll:doc.currency")];
  const rows = report.employees.map((e, i) => [String(i + 1), e.employee_code ?? "", e.full_name,
    ...earn.map((n) => amountIn(e, n, ["earning", "allowance"], isRtl)), Number(e.total_earnings),
    ...ded.map((n) => amountIn(e, n, ["deduction"], isRtl)), Number(e.total_deductions), Number(e.total_installments), Number(e.net_salary), e.currency]);
  const totals = report.totals.map((total) => ["", "", `${t("payroll:doc.total")} (${total.currency})`,
    ...earn.map((n) => report.employees.filter((e) => e.currency === total.currency).reduce((s, e) => s + amountIn(e, n, ["earning", "allowance"], isRtl), 0)),
    Number(total.earnings),
    ...ded.map((n) => report.employees.filter((e) => e.currency === total.currency).reduce((s, e) => s + amountIn(e, n, ["deduction"], isRtl), 0)),
    Number(total.deductions), Number(total.installments), Number(total.net), total.currency]);
  return { head, rows, totals };
}

function combinedTable(report: PayrollReport, t: T, isRtl: boolean): Table {
  const allowances = columnsOf(report, ["allowance"], isRtl);
  const head = ["#", t("payroll:doc.code"), t("payroll:doc.employee"), t("payroll:doc.basic"), ...allowances, t("payroll:doc.totalAllowances"), t("payroll:doc.combined"), t("payroll:doc.currency")];
  const rows = report.employees.map((e, i) => [String(i + 1), e.employee_code ?? "", e.full_name, Number(e.base_salary),
    ...allowances.map((n) => amountIn(e, n, ["allowance"], isRtl)), Number(e.total_allowances), Number(e.combined_total), e.currency]);
  const totals = report.totals.map((total) => ["", "", `${t("payroll:doc.total")} (${total.currency})`, Number(total.base),
    ...allowances.map((n) => report.employees.filter((e) => e.currency === total.currency).reduce((s, e) => s + amountIn(e, n, ["allowance"], isRtl), 0)),
    Number(total.allowances), Number(total.combined), total.currency]);
  return { head, rows, totals };
}

function tableHtml(table: Table, isRtl: boolean): string {
  const cell = (value: Cell, bold = false) =>
    `<td style="padding:5px 6px;border:1px solid ${RULE};${typeof value === "number" ? `text-align:${isRtl ? "left" : "right"};white-space:nowrap;` : ""}${bold ? "font-weight:700;" : ""}">${escapeHtml(typeof value === "number" ? money(value) : value)}</td>`;
  return `<table style="width:100%;border-collapse:collapse;font-size:10px;">
    <thead><tr style="background:${NAVY};color:#fff;">${table.head.map((h) => `<th style="padding:6px;border:1px solid ${NAVY};">${escapeHtml(h)}</th>`).join("")}</tr></thead>
    <tbody>${table.rows.map((r) => `<tr>${r.map((c) => cell(c)).join("")}</tr>`).join("")}
    ${table.totals.map((r) => `<tr style="background:${BAND};">${r.map((c) => cell(c, true)).join("")}</tr>`).join("")}</tbody></table>`;
}

export async function buildSummaryPdf(report: PayrollReport, t: T, isRtl: boolean, combined: boolean): Promise<jsPDF> {
  const table = combined ? combinedTable(report, t, isRtl) : summaryTable(report, t, isRtl);
  const el = container(isRtl, 1120);
  el.innerHTML = `${header(report, t, t(combined ? "payroll:reports.combined" : "payroll:reports.summary"))}
    ${tableHtml(table, isRtl)}
    ${combined ? `<div style="margin-top:8px;font-size:11px;color:#475569;">${escapeHtml(t("payroll:doc.combinedNotNet"))}</div>` : ""}
    ${footer(report, t)}`;
  return renderHtmlToPdf(el, { landscape: true });
}

export function buildReportXlsx(report: PayrollReport, t: T, isRtl: boolean, combined: boolean): Uint8Array {
  const table = combined ? combinedTable(report, t, isRtl) : summaryTable(report, t, isRtl);
  return toXlsx([table.head, ...table.rows, ...table.totals], isRtl, { freezeHeader: true, autoFilter: true, sheetName: t(combined ? "payroll:reports.combined" : "payroll:reports.summary") });
}
