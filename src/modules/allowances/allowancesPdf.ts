import type { jsPDF } from "jspdf";
import type { AllowanceEntry } from "../../core/repositories/AllowanceRepository";
import { formatDateOnly, formatTimeOnly } from "../../core/utils/formatDate";
import { renderHtmlToPdf, escapeHtml } from "../../core/utils/htmlToPdf";
import prosmLogo from "../../assets/prosm-logo-pdf.png";

type TFunc = (key: string, options?: Record<string, unknown>) => string;

const dayTotal = (entry: AllowanceEntry) =>
  entry.mealAllowance +
  entry.expatriationAllowance +
  entry.transportationAllowance +
  entry.housingAllowance +
  entry.travelAllowance +
  entry.otherAllowance +
  entry.overtimeAmount +
  entry.extraDaysAmount;

// PROSM Time - Allowances PDF export, same certified-document shell
// (two-logo header, html2canvas capture via renderHtmlToPdf) as
// Timesheets/Attendance Record's own PDFs.
export function buildAllowancesPdf(entries: AllowanceEntry[], startDate: string, endDate: string, languageCode: string, t: TFunc, organizationLogoUrl?: string | null): Promise<jsPDF> {
  const isRtl = languageCode === "ar";
  const locale = languageCode;

  const bodyRows =
    entries.length === 0
      ? `<tr><td colspan="15" style="padding:14px;text-align:center;color:#64748b;">${escapeHtml(t("empty"))}</td></tr>`
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
          <td style="padding:6px 8px;border-top:1px solid #e2e8f0;">${entry.overtimeDays.toFixed(1)}</td>
          <td style="padding:6px 8px;border-top:1px solid #e2e8f0;">${entry.housingAllowance.toFixed(2)}</td>
          <td style="padding:6px 8px;border-top:1px solid #e2e8f0;">${entry.travelAllowance.toFixed(2)}</td>
          <td style="padding:6px 8px;border-top:1px solid #e2e8f0;">${entry.otherAllowance.toFixed(2)}</td>
          <td style="padding:6px 8px;border-top:1px solid #e2e8f0;">${(entry.overtimeAmount + entry.extraDaysAmount).toFixed(2)}</td>
          <td style="padding:6px 8px;border-top:1px solid #e2e8f0;font-weight:700;">${dayTotal(entry).toFixed(2)}</td>
        </tr>`,
          )
          .join("");

  // § live UX review, user-directed - "a vertical total at the bottom
  // of the table" - one summed value per numeric column.
  const totals = entries.reduce(
    (acc, entry) => ({
      meal: acc.meal + entry.mealAllowance,
      expatriation: acc.expatriation + entry.expatriationAllowance,
      transportation: acc.transportation + entry.transportationAllowance,
      overtimeHours: acc.overtimeHours + entry.overtimeHours,
      overtimeDays: acc.overtimeDays + entry.overtimeDays,
      housing: acc.housing + entry.housingAllowance,
      travel: acc.travel + entry.travelAllowance,
      other: acc.other + entry.otherAllowance,
      overtimeValue: acc.overtimeValue + entry.overtimeAmount + entry.extraDaysAmount,
      total: acc.total + dayTotal(entry),
    }),
    { meal: 0, expatriation: 0, transportation: 0, overtimeHours: 0, overtimeDays: 0, housing: 0, travel: 0, other: 0, overtimeValue: 0, total: 0 },
  );

  const totalsRow =
    entries.length === 0
      ? ""
      : `
    <tr style="background:#f8fafc;font-weight:700;">
      <td colspan="5" style="padding:6px 8px;border-top:2px solid #cbd5e1;text-align:${isRtl ? "left" : "right"};">${escapeHtml(t("detail.totalsLabel"))}</td>
      <td style="padding:6px 8px;border-top:2px solid #cbd5e1;">${totals.meal.toFixed(2)}</td>
      <td style="padding:6px 8px;border-top:2px solid #cbd5e1;">${totals.expatriation.toFixed(2)}</td>
      <td style="padding:6px 8px;border-top:2px solid #cbd5e1;">${totals.transportation.toFixed(2)}</td>
      <td style="padding:6px 8px;border-top:2px solid #cbd5e1;">${totals.overtimeHours.toFixed(2)}</td>
      <td style="padding:6px 8px;border-top:2px solid #cbd5e1;">${totals.overtimeDays.toFixed(1)}</td>
      <td style="padding:6px 8px;border-top:2px solid #cbd5e1;">${totals.housing.toFixed(2)}</td>
      <td style="padding:6px 8px;border-top:2px solid #cbd5e1;">${totals.travel.toFixed(2)}</td>
      <td style="padding:6px 8px;border-top:2px solid #cbd5e1;">${totals.other.toFixed(2)}</td>
      <td style="padding:6px 8px;border-top:2px solid #cbd5e1;">${totals.overtimeValue.toFixed(2)}</td>
      <td style="padding:6px 8px;border-top:2px solid #cbd5e1;">${totals.total.toFixed(2)}</td>
    </tr>`;

  const container = document.createElement("div");
  container.dir = isRtl ? "rtl" : "ltr";
  container.style.cssText = "width:900px;padding:36px;background:#ffffff;color:#0f172a;font-family:'Segoe UI',Tahoma,Arial,sans-serif;";

  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:3px solid #1e6fd9;padding-bottom:16px;margin-bottom:20px;">
      <img src="${prosmLogo}" style="height:44px;width:44px;object-fit:contain;" />
      <div style="text-align:center;flex:1;">
        <div style="font-size:19px;font-weight:700;">${escapeHtml(t("title"))}</div>
        <div style="font-size:12px;color:#64748b;margin-top:2px;">${escapeHtml(startDate)} — ${escapeHtml(endDate)}</div>
      </div>
      ${organizationLogoUrl ? `<img src="${escapeHtml(organizationLogoUrl)}" style="height:44px;max-width:80px;object-fit:contain;" />` : `<div style="width:44px;"></div>`}
    </div>

    <table style="width:100%;border-collapse:collapse;font-size:10px;">
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
          <th style="padding:6px 8px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("columns.overtimeDays"))}</th>
          <th style="padding:6px 8px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("columns.housing"))}</th>
          <th style="padding:6px 8px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("columns.travel"))}</th>
          <th style="padding:6px 8px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("columns.other"))}</th>
          <th style="padding:6px 8px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("columns.overtimeAmount"))}</th>
          <th style="padding:6px 8px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("columns.total"))}</th>
        </tr>
      </thead>
      <tbody>${bodyRows}</tbody>
      <tfoot>${totalsRow}</tfoot>
    </table>

    <div style="display:flex;justify-content:space-between;gap:24px;margin-top:36px;font-size:12px;color:#334155;">
      <div>${escapeHtml(t("pdf.employeeSignature"))}: ______________________</div>
      <div>${escapeHtml(t("pdf.managerApproval"))}: ______________________</div>
    </div>
  `;

  return renderHtmlToPdf(container);
}
