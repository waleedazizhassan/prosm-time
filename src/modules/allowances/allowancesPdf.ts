import type { jsPDF } from "jspdf";
import type { AllowanceEntry } from "../../core/repositories/AllowanceRepository";
import { formatDateOnly, formatTimeOnly } from "../../core/utils/formatDate";
import { renderHtmlToPdf, escapeHtml } from "../../core/utils/htmlToPdf";
import prosmLogo from "../../assets/prosm-logo.png";

type TFunc = (key: string, options?: Record<string, unknown>) => string;

// PROSM Time - Allowances PDF export, same certified-document shell
// (two-logo header, html2canvas capture via renderHtmlToPdf) as
// Timesheets/Attendance Record's own PDFs.
export function buildAllowancesPdf(entries: AllowanceEntry[], startDate: string, endDate: string, languageCode: string, t: TFunc, organizationLogoUrl?: string | null): Promise<jsPDF> {
  const isRtl = languageCode === "ar";
  const locale = languageCode;

  const bodyRows =
    entries.length === 0
      ? `<tr><td colspan="12" style="padding:14px;text-align:center;color:#64748b;">${escapeHtml(t("empty"))}</td></tr>`
      : entries
          .map(
            (entry) => `
        <tr>
          <td style="padding:6px 8px;border-top:1px solid #e2e8f0;">${escapeHtml(entry.userFullName)}</td>
          <td style="padding:6px 8px;border-top:1px solid #e2e8f0;">${escapeHtml(formatDateOnly(entry.entryDate, locale))}</td>
          <td style="padding:6px 8px;border-top:1px solid #e2e8f0;">${escapeHtml(entry.siteName || "—")}</td>
          <td style="padding:6px 8px;border-top:1px solid #e2e8f0;">${entry.clockInAt ? escapeHtml(formatTimeOnly(entry.clockInAt, locale)) : "—"}</td>
          <td style="padding:6px 8px;border-top:1px solid #e2e8f0;">${entry.clockOutAt ? escapeHtml(formatTimeOnly(entry.clockOutAt, locale)) : "—"}</td>
          <td style="padding:6px 8px;border-top:1px solid #e2e8f0;">${entry.mealAllowance.toFixed(2)}</td>
          <td style="padding:6px 8px;border-top:1px solid #e2e8f0;">${entry.expatriationAllowance.toFixed(2)}</td>
          <td style="padding:6px 8px;border-top:1px solid #e2e8f0;">${entry.transportationAllowance.toFixed(2)}</td>
          <td style="padding:6px 8px;border-top:1px solid #e2e8f0;">${entry.overtimeHours.toFixed(2)}</td>
          <td style="padding:6px 8px;border-top:1px solid #e2e8f0;">${entry.housingAllowance.toFixed(2)}</td>
          <td style="padding:6px 8px;border-top:1px solid #e2e8f0;">${entry.travelAllowance.toFixed(2)}</td>
          <td style="padding:6px 8px;border-top:1px solid #e2e8f0;">${entry.otherAllowance.toFixed(2)}</td>
        </tr>`,
          )
          .join("");

  const container = document.createElement("div");
  container.dir = isRtl ? "rtl" : "ltr";
  container.style.cssText = "width:900px;padding:36px;background:#ffffff;color:#0f172a;font-family:'Segoe UI',Tahoma,Arial,sans-serif;";

  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:3px solid #16a34a;padding-bottom:16px;margin-bottom:20px;">
      <img src="${prosmLogo}" style="height:44px;width:44px;object-fit:contain;" />
      <div style="text-align:center;flex:1;">
        <div style="font-size:19px;font-weight:700;">${escapeHtml(t("title"))}</div>
        <div style="font-size:12px;color:#64748b;margin-top:2px;">${escapeHtml(startDate)} — ${escapeHtml(endDate)}</div>
      </div>
      ${organizationLogoUrl ? `<img src="${organizationLogoUrl}" style="height:44px;max-width:80px;object-fit:contain;" />` : `<div style="width:44px;"></div>`}
    </div>

    <table style="width:100%;border-collapse:collapse;font-size:10.5px;">
      <thead>
        <tr style="background:#f1f5f9;">
          <th style="padding:6px 8px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("columns.employee"))}</th>
          <th style="padding:6px 8px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("columns.date"))}</th>
          <th style="padding:6px 8px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("columns.site"))}</th>
          <th style="padding:6px 8px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("columns.clockIn"))}</th>
          <th style="padding:6px 8px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("columns.clockOut"))}</th>
          <th style="padding:6px 8px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("columns.meal"))}</th>
          <th style="padding:6px 8px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("columns.expatriation"))}</th>
          <th style="padding:6px 8px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("columns.transportation"))}</th>
          <th style="padding:6px 8px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("columns.overtimeHours"))}</th>
          <th style="padding:6px 8px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("columns.housing"))}</th>
          <th style="padding:6px 8px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("columns.travel"))}</th>
          <th style="padding:6px 8px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("columns.other"))}</th>
        </tr>
      </thead>
      <tbody>${bodyRows}</tbody>
    </table>
  `;

  return renderHtmlToPdf(container);
}
