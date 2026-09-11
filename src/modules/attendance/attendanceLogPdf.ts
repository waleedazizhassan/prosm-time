import type { jsPDF } from "jspdf";
import type { TodayAttendanceRow } from "../../core/repositories/ManagerRepository";
import { formatTimeOnly } from "../../core/utils/formatDate";
import { renderHtmlToPdf, escapeHtml } from "../../core/utils/htmlToPdf";
import prosmLogo from "../../assets/prosm-logo.png";

type TFunc = (key: string, options?: Record<string, unknown>) => string;

function formatWorkedHours(clockInAt: string, clockOutAt: string | null): string {
  const endMs = clockOutAt ? new Date(clockOutAt).getTime() : Date.now();
  const totalMinutes = Math.max(0, Math.round((endMs - new Date(clockInAt).getTime()) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

// PROSM Time - "same PDF approach as the Timesheets report" (live UX
// review, user-directed). Reuses the exact same certified-document
// shell (two-logo header, renderHtmlToPdf's html2canvas capture -
// timesheetPdf.ts) rather than a different export mechanism, over
// whatever rows are already on screen (already scoped by RLS and
// already sorted the way the caller chose - this module has no
// authorization or ordering logic of its own).
export function buildAttendanceLogPdf(
  rows: TodayAttendanceRow[],
  startDate: string,
  endDate: string,
  languageCode: string,
  t: TFunc,
  organizationLogoUrl?: string | null,
): Promise<jsPDF> {
  const isRtl = languageCode === "ar";
  const locale = languageCode;

  const bodyRows =
    rows.length === 0
      ? `<tr><td colspan="6" style="padding:14px;text-align:center;color:#64748b;">${escapeHtml(t("empty"))}</td></tr>`
      : rows
          .map(
            (row) => `
        <tr>
          <td style="padding:6px 10px;border-top:1px solid #e2e8f0;">${escapeHtml(row.userFullName)}</td>
          <td style="padding:6px 10px;border-top:1px solid #e2e8f0;">${escapeHtml(row.siteName || "—")}</td>
          <td style="padding:6px 10px;border-top:1px solid #e2e8f0;">${escapeHtml(formatTimeOnly(row.clockInAt, locale))}${row.clockInRecordedByName ? `<br/><span style="font-size:10px;color:#64748b;">${escapeHtml(t("recordedByOnBehalf", { name: row.clockInRecordedByName }))}</span>` : ""}</td>
          <td style="padding:6px 10px;border-top:1px solid #e2e8f0;">${row.clockOutAt ? escapeHtml(formatTimeOnly(row.clockOutAt, locale)) : "—"}${row.clockOutRecordedByName ? `<br/><span style="font-size:10px;color:#64748b;">${escapeHtml(t("recordedByOnBehalf", { name: row.clockOutRecordedByName }))}</span>` : ""}</td>
          <td style="padding:6px 10px;border-top:1px solid #e2e8f0;">${escapeHtml(t(`status.${row.status}`))}</td>
          <td style="padding:6px 10px;border-top:1px solid #e2e8f0;">${escapeHtml(formatWorkedHours(row.clockInAt, row.clockOutAt))}</td>
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
        <div style="font-size:19px;font-weight:700;">${escapeHtml(t("title"))}</div>
        <div style="font-size:12px;color:#64748b;margin-top:2px;">${escapeHtml(startDate)} — ${escapeHtml(endDate)}</div>
      </div>
      ${organizationLogoUrl ? `<img src="${organizationLogoUrl}" style="height:44px;max-width:80px;object-fit:contain;" />` : `<div style="width:44px;"></div>`}
    </div>

    <table style="width:100%;border-collapse:collapse;font-size:11.5px;">
      <thead>
        <tr style="background:#f1f5f9;">
          <th style="padding:6px 10px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("columns.employee"))}</th>
          <th style="padding:6px 10px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("columns.site"))}</th>
          <th style="padding:6px 10px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("columns.clockInAt"))}</th>
          <th style="padding:6px 10px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("columns.clockOutAt"))}</th>
          <th style="padding:6px 10px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("columns.status"))}</th>
          <th style="padding:6px 10px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("columns.workedHours"))}</th>
        </tr>
      </thead>
      <tbody>${bodyRows}</tbody>
    </table>
  `;

  return renderHtmlToPdf(container);
}
