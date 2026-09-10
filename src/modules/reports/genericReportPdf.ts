import type { jsPDF } from "jspdf";
import { renderHtmlToPdf, escapeHtml } from "../../core/utils/htmlToPdf";
import prosmLogo from "../../assets/prosm-logo.png";

export interface GenericReportColumn {
  header: string;
}

// PROSM Time - 14-point live-audit gap #8: 7 new report types
// (Workforce, Site, Late, Missing-Checkout, Leave-Conflict, Manager-
// Override, Location-Violations) each need a PDF export. Rather than 7
// near-identical copies of attendanceLogPdf.ts's own document shell
// (two-logo header, html2canvas capture via renderHtmlToPdf), this is
// that same shell factored out to take arbitrary columns/rows - every
// new report type supplies its own column headers and pre-formatted
// row strings, nothing else changes. attendanceLogPdf.ts/allowancesPdf.ts
// stay as they are (both predate this and already work) - this is only
// for the 7 new types.
export function buildGenericReportPdf(
  title: string,
  dateRangeLabel: string,
  columns: GenericReportColumn[],
  rows: string[][],
  emptyMessage: string,
  isRtl: boolean,
  organizationLogoUrl?: string | null,
): Promise<jsPDF> {
  const bodyRows =
    rows.length === 0
      ? `<tr><td colspan="${columns.length}" style="padding:14px;text-align:center;color:#64748b;">${escapeHtml(emptyMessage)}</td></tr>`
      : rows
          .map(
            (row) => `
        <tr>
          ${row.map((cell) => `<td style="padding:6px 10px;border-top:1px solid #e2e8f0;">${escapeHtml(cell)}</td>`).join("")}
        </tr>`,
          )
          .join("");

  const container = document.createElement("div");
  container.dir = isRtl ? "rtl" : "ltr";
  container.style.cssText = "width:780px;padding:36px;background:#ffffff;color:#0f172a;font-family:'Segoe UI',Tahoma,Arial,sans-serif;";

  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:3px solid #16a34a;padding-bottom:16px;margin-bottom:20px;">
      <img src="${prosmLogo}" style="height:44px;width:44px;object-fit:contain;" />
      <div style="text-align:center;flex:1;">
        <div style="font-size:19px;font-weight:700;">${escapeHtml(title)}</div>
        <div style="font-size:12px;color:#64748b;margin-top:2px;">${escapeHtml(dateRangeLabel)}</div>
      </div>
      ${organizationLogoUrl ? `<img src="${organizationLogoUrl}" style="height:44px;max-width:80px;object-fit:contain;" />` : `<div style="width:44px;"></div>`}
    </div>

    <table style="width:100%;border-collapse:collapse;font-size:11.5px;">
      <thead>
        <tr style="background:#f1f5f9;">
          ${columns.map((col) => `<th style="padding:6px 10px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(col.header)}</th>`).join("")}
        </tr>
      </thead>
      <tbody>${bodyRows}</tbody>
    </table>
  `;

  return renderHtmlToPdf(container);
}
