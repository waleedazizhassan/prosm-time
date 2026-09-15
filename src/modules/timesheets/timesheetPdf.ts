import type { jsPDF } from "jspdf";
import type { EvidencePack } from "../../core/repositories/TimesheetRepository";
import { formatDateTime, formatTimeOnly, formatDateOnly } from "../../core/utils/formatDate";
import { renderHtmlToPdf, escapeHtml, sectionHeadingStyle } from "../../core/utils/htmlToPdf";
import prosmLogo from "../../assets/prosm-logo.png";

export function formatMinutes(minutes: number): string {
  const totalMinutes = Math.round(minutes);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return `${hours}h ${mins}m`;
}

type TFunc = (key: string, options?: Record<string, unknown>) => string;

// § live UX review, user-directed - "if I want to pull an end-of-month
// CERTIFIED copy: period on it, the client's logo and PROSM's logo,
// and a table with days/sites/clock-in/clock-out/hours." A real
// redesign, not a tweak. Two prior jsPDF approaches were tried and both
// mangled Arabic: (1) jsPDF's native text()/the built-in "helvetica"
// font only supports Latin-1; (2) jsPDF's own .html() helper turned out
// to ALWAYS reconstruct visible text natively with that same limited
// font, regardless of its `autoPaging` option (confirmed live - the
// on-screen preview rendered correctly, but the downloaded .html()-based
// PDF still didn't). The approach that actually works: render this
// template to a canvas directly via html2canvas (already a real
// dependency here - the browser's own text engine does Arabic shaping/
// RTL correctly for free), then embed that canvas as a plain JPEG image
// via addImage() - jsPDF never touches the text as text, only as pixels
// it already rendered correctly. Built as its own offscreen template
// (not a reuse of the on-screen Report page's markup) so the certified
// document's layout - two logos, a bordered table - is deliberate, not
// incidental to on-screen UI chrome.
export function buildTimesheetPdf(pack: EvidencePack, languageCode: string, t: TFunc, organizationLogoUrl?: string | null): Promise<jsPDF> {
  const isRtl = languageCode === "ar";
  const locale = languageCode;

  // § found live while verifying this fix - a real timesheet's own
  // cached timesheet.totalLeaveDays (computed once at generation time)
  // can drift out of sync with reality if a leave request is approved
  // afterward (confirmed against real data: a real timesheet showed
  // totalLeaveDays=0 while a real approved leave_requests row clearly
  // overlapped its period). Summing pack.leaveEntries directly keeps
  // this printed document internally consistent with its own Leave
  // section below, always - not dependent on when that cache was last
  // recomputed.
  const totalLeaveDays = pack.leaveEntries.reduce((sum, entry) => sum + entry.daysCount, 0);

  const summaryRow = (label: string, value: string) => `
    <td style="padding:5px 10px;color:#64748b;white-space:nowrap;">${escapeHtml(label)}</td>
    <td style="padding:5px 10px;font-weight:600;color:#0f172a;">${escapeHtml(value)}</td>
  `;

  // Per-entry overtime doesn't exist in the domain model (only the
  // whole period's total does - attendance_sessions/timesheet_entries
  // carry worked/break minutes per session, overtime is a period-level
  // computation) - showing it as a table TOTAL row is the honest
  // representation of real data, not a fabricated per-day split.
  const entriesRows =
    pack.entries.length === 0
      ? `<tr><td colspan="6" style="padding:14px;text-align:center;color:#64748b;">${escapeHtml(t("detail.noEntries"))}</td></tr>`
      : pack.entries
          .map(
            (entry) => `
        <tr>
          <td style="padding:6px 10px;border-top:1px solid #e2e8f0;">${escapeHtml(formatDateOnly(entry.clockInAt, locale))}</td>
          <td style="padding:6px 10px;border-top:1px solid #e2e8f0;">${escapeHtml(entry.siteName ?? "—")}${entry.projectName ? " · " + escapeHtml(entry.projectName) : ""}</td>
          <td style="padding:6px 10px;border-top:1px solid #e2e8f0;">${escapeHtml(formatTimeOnly(entry.clockInAt, locale))}</td>
          <td style="padding:6px 10px;border-top:1px solid #e2e8f0;">${entry.clockOutAt ? escapeHtml(formatTimeOnly(entry.clockOutAt, locale)) : escapeHtml(t("detail.stillOpen"))}</td>
          <td style="padding:6px 10px;border-top:1px solid #e2e8f0;">${escapeHtml(formatMinutes(entry.workedMinutes))}</td>
          <td style="padding:6px 10px;border-top:1px solid #e2e8f0;">${escapeHtml(formatMinutes(entry.breakMinutes))}</td>
        </tr>`
          )
          .join("");

  const headingStyle = sectionHeadingStyle(isRtl);

  const listSection = (title: string, rows: string, emptyMessage: string) => `
    <div style="${headingStyle}">${escapeHtml(title)}</div>
    ${rows || `<p style="margin:0;font-size:11px;color:#64748b;">${escapeHtml(emptyMessage)}</p>`}
  `;

  const exceptionsRows = pack.exceptions
    .map(
      (exception) => `
      <div style="font-size:11px;color:#334155;padding:4px 0;border-top:1px solid #f1f5f9;">
        ${escapeHtml(formatDateTime(exception.createdAt, locale))} · ${Math.round(exception.distanceMeters)} m · ${escapeHtml(exception.reasonCategory ?? "—")} · ${escapeHtml(exception.employeeReason ?? "—")} · ${escapeHtml(exception.status)}
      </div>`
    )
    .join("");

  const correctionsRows = [
    ...pack.corrections.map(
      (correction) => `
      <div style="font-size:11px;color:#334155;padding:4px 0;border-top:1px solid #f1f5f9;">
        ${escapeHtml(formatDateTime(correction.createdAt, locale))} · ${escapeHtml(correction.proposedEventType)} · ${escapeHtml(correction.reason)} · ${escapeHtml(correction.status)}
      </div>`
    ),
    ...pack.timesheetCorrections.map(
      (correction) => `
      <div style="font-size:11px;color:#334155;padding:4px 0;border-top:1px solid #f1f5f9;">
        ${escapeHtml(formatDateTime(correction.createdAt, locale))} · ${escapeHtml(t("report.timesheetLevelCorrection"))} · ${escapeHtml(correction.reason)} · ${escapeHtml(correction.status)}
      </div>`
    ),
  ].join("");

  // § real gap fix, user-reported (#6, 2026-09-15) - "leave isn't
  // recorded in the timesheet PDF... remove the photos, they're
  // useless printed - just become a label, nothing more." The old
  // "Evidence" section here only ever listed captured-at/content-type
  // TEXT for each camera_evidence row (never the actual image) - on a
  // printed page that reads as exactly the useless label the user
  // describes, so it's removed entirely rather than kept as dead
  // weight. Real evidence photos are still viewable on-screen
  // (TimesheetsPage.tsx/ManagerConsolePage.tsx's own photo modals) -
  // this only ever affected the printed document.
  const leaveRows = pack.leaveEntries
    .map(
      (leave) => `
      <div style="font-size:11px;color:#334155;padding:4px 0;border-top:1px solid #f1f5f9;">
        ${escapeHtml(t(`values.leaveType.${leave.leaveType}`, { defaultValue: leave.leaveType }))} · ${escapeHtml(formatDateOnly(leave.startDate, locale))} — ${escapeHtml(formatDateOnly(leave.endDate, locale))} · ${escapeHtml(t("report.leaveDays", { count: leave.daysCount }))}${leave.reason ? " · " + escapeHtml(leave.reason) : ""}
      </div>`
    )
    .join("");

  const approvalTrailRows = pack.approvalTrail
    .map(
      (row) => `
      <div style="font-size:11px;color:#334155;padding:4px 0;border-top:1px solid #f1f5f9;">
        ${escapeHtml(formatDateTime(row.createdAt, locale))} · ${escapeHtml(row.actorName)} · ${escapeHtml(row.action)} · ${escapeHtml(row.notes ?? "—")}
      </div>`
    )
    .join("");

  // § live UX review, user-directed - "the PDF comes out completely
  // blank." Root cause: jsPDF's .html() clones the element it's given
  // (outerHTML, inline styles included) into its OWN internal hidden
  // iframe before running html2canvas on the clone - the container's
  // own `position:fixed;left:-9999px` (meant to hide it from the real
  // page) rode along into that clone too, so the cloned content was
  // ALSO shifted off-screen inside jsPDF's own iframe, and html2canvas
  // captured nothing. Fixed by moving the hiding entirely onto a
  // WRAPPER (zero-size, overflow:hidden - never cloned, since only
  // `container` itself is passed to .html()) and leaving `container`
  // itself unpositioned, so the clone renders normally in-flow.
  const container = document.createElement("div");
  container.dir = isRtl ? "rtl" : "ltr";
  container.style.cssText = "width:780px;padding:36px;background:#ffffff;color:#0f172a;font-family:'Segoe UI',Tahoma,Arial,sans-serif;";

  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:3px solid #16a34a;padding-bottom:16px;margin-bottom:20px;">
      <img src="${prosmLogo}" style="height:44px;width:44px;object-fit:contain;" />
      <div style="text-align:center;flex:1;">
        <div style="font-size:19px;font-weight:700;">${escapeHtml(t("report.title"))}</div>
        <div style="font-size:12px;color:#64748b;margin-top:2px;">${escapeHtml(pack.employee.fullName)} — ${escapeHtml(pack.timesheet.periodStart)} — ${escapeHtml(pack.timesheet.periodEnd)}</div>
      </div>
      ${organizationLogoUrl ? `<img src="${organizationLogoUrl}" style="height:44px;max-width:80px;object-fit:contain;" />` : `<div style="width:44px;"></div>`}
    </div>

    <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:8px;">
      <tr>${summaryRow(t("report.organization"), `${pack.organization.name} (${pack.organization.organizationCode})`)}${summaryRow(t("report.employee"), `${pack.employee.fullName} (${pack.employee.email})`)}</tr>
      <tr>${summaryRow(t("report.status"), t(`status.${pack.timesheet.status}`))}${summaryRow(t("report.lockStatus"), pack.timesheet.lockedAt ? t("report.locked") : t("report.unlocked"))}</tr>
      <tr>${summaryRow(t("report.worked"), formatMinutes(pack.timesheet.totalWorkedMinutes))}${summaryRow(t("report.overtime"), formatMinutes(pack.timesheet.totalOvertimeMinutes))}</tr>
      <tr>${summaryRow(t("report.breaks"), formatMinutes(pack.timesheet.totalBreakMinutes))}${summaryRow(t("report.approver"), pack.timesheet.approverName ?? "—")}</tr>
      <tr>${summaryRow(t("report.approvedAt"), pack.timesheet.approvedAt ? formatDateTime(pack.timesheet.approvedAt, locale) : "—")}${summaryRow(t("report.leaveDaysLabel"), t("report.leaveDays", { count: totalLeaveDays }))}</tr>
    </table>

    <div style="${headingStyle}">${escapeHtml(t("report.entriesTitle"))}</div>
    <table style="width:100%;border-collapse:collapse;font-size:11.5px;">
      <thead>
        <tr style="background:#f1f5f9;">
          <th style="padding:6px 10px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("columns.date"))}</th>
          <th style="padding:6px 10px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("columns.site"))}</th>
          <th style="padding:6px 10px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("columns.clockIn"))}</th>
          <th style="padding:6px 10px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("columns.clockOut"))}</th>
          <th style="padding:6px 10px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("columns.worked"))}</th>
          <th style="padding:6px 10px;text-align:${isRtl ? "right" : "left"};">${escapeHtml(t("detail.breaks"))}</th>
        </tr>
      </thead>
      <tbody>${entriesRows}</tbody>
      <tfoot>
        <tr style="background:#f8fafc;font-weight:700;">
          <td colspan="4" style="padding:6px 10px;border-top:2px solid #cbd5e1;text-align:${isRtl ? "left" : "right"};">${escapeHtml(t("report.worked"))} / ${escapeHtml(t("report.overtime"))}</td>
          <td colspan="2" style="padding:6px 10px;border-top:2px solid #cbd5e1;">${escapeHtml(formatMinutes(pack.timesheet.totalWorkedMinutes))} / ${escapeHtml(formatMinutes(pack.timesheet.totalOvertimeMinutes))}</td>
        </tr>
      </tfoot>
    </table>

    ${listSection(t("report.leaveTitle"), leaveRows, t("report.noLeave"))}
    ${listSection(t("report.exceptionsTitle"), exceptionsRows, t("report.noExceptions"))}
    ${listSection(t("report.correctionsTitle"), correctionsRows, t("report.noCorrections"))}
    ${listSection(t("report.approvalTrailTitle"), approvalTrailRows, t("report.noApprovalTrail"))}
  `;

  // § live UX review, user-directed - "the on-screen preview is
  // correct, but the downloaded PDF still comes out garbled." Root
  // cause, finally isolated by comparing the on-screen render (correct)
  // against the actual downloaded file (still garbled): jsPDF's own
  // .html() ALWAYS reconstructs visible text natively - using its own
  // built-in Latin-1-only font - regardless of the `autoPaging` option;
  // that option only ever controlled how page breaks are computed, not
  // whether .html() draws real PDF text at all. There is no jsPDF
  // .html() setting that avoids this for non-Latin scripts. Fixed by
  // not using .html() at all - renderHtmlToPdf() (core/utils/
  // htmlToPdf.ts) captures `container` with html2canvas instead and
  // embeds the result as a plain image.
  return renderHtmlToPdf(container);
}
