import { jsPDF } from "jspdf";
import type { EvidencePack } from "../../core/repositories/TimesheetRepository";
import { formatDateTime, formatTimeOnly, formatDateOnly } from "../../core/utils/formatDate";
import prosmLogo from "../../assets/prosm-logo.png";

export function formatMinutes(minutes: number): string {
  const totalMinutes = Math.round(minutes);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return `${hours}h ${mins}m`;
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

type TFunc = (key: string, options?: Record<string, unknown>) => string;

// § live UX review, user-directed - "if I want to pull an end-of-month
// CERTIFIED copy: period on it, the client's logo and PROSM's logo,
// and a table with days/sites/clock-in/clock-out/hours." A real
// redesign, not a tweak - previously jsPDF's own native text() drawing
// with the "helvetica" built-in font, which only supports Latin-1 and
// silently mangled Arabic into garbage glyphs (confirmed live - the
// exact bug this replaces). jsPDF's own .html() (backed by html2canvas,
// already a real dependency here) rasterizes real DOM/CSS instead - the
// browser's own text engine does Arabic shaping/RTL correctly for
// free, no font-embedding or bidi-reordering library needed. Built as
// its own offscreen template (not a reuse of the on-screen Report
// page's markup) so the certified document's layout - two logos, a
// bordered table - is deliberate, not incidental to on-screen UI chrome.
export async function buildTimesheetPdf(pack: EvidencePack, languageCode: string, t: TFunc, organizationLogoUrl?: string | null): Promise<jsPDF> {
  const isRtl = languageCode === "ar";
  const locale = languageCode;

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

  const listSection = (title: string, rows: string, emptyMessage: string) => `
    <div style="font-weight:700;font-size:12px;letter-spacing:0.03em;text-transform:uppercase;color:#0f172a;border-bottom:1px solid #cbd5e1;padding-bottom:6px;margin:20px 0 8px;">${escapeHtml(title)}</div>
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

  const evidenceRows = pack.evidenceReferences
    .map(
      (evidence) => `
      <div style="font-size:11px;color:#334155;padding:4px 0;border-top:1px solid #f1f5f9;">
        ${escapeHtml(formatDateTime(evidence.capturedAt, locale))} · ${escapeHtml(evidence.contentType)}
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
  const wrapper = document.createElement("div");
  wrapper.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;overflow:hidden;";

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
      <tr>${summaryRow(t("report.approvedAt"), pack.timesheet.approvedAt ? formatDateTime(pack.timesheet.approvedAt, locale) : "—")}<td></td><td></td></tr>
    </table>

    <div style="font-weight:700;font-size:12px;letter-spacing:0.03em;text-transform:uppercase;color:#0f172a;border-bottom:1px solid #cbd5e1;padding-bottom:6px;margin:20px 0 8px;">${escapeHtml(t("report.entriesTitle"))}</div>
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

    ${listSection(t("report.exceptionsTitle"), exceptionsRows, t("report.noExceptions"))}
    ${listSection(t("report.correctionsTitle"), correctionsRows, t("report.noCorrections"))}
    ${listSection(t("report.evidenceTitle"), evidenceRows, t("report.noEvidence"))}
    ${listSection(t("report.approvalTrailTitle"), approvalTrailRows, t("report.noApprovalTrail"))}
  `;

  wrapper.appendChild(container);
  document.body.appendChild(wrapper);

  try {
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    // autoPaging: "slice" (not "text") deliberately - "text" mode makes
    // jsPDF walk the DOM a second time and reconstruct real PDF text
    // objects using its OWN built-in Latin-1-only font, which would
    // silently reintroduce the exact Arabic-mangling bug this rewrite
    // exists to fix, underneath/alongside the correct html2canvas
    // raster. "slice" instead paginates by cutting the already-correct
    // html2canvas screenshot itself - what ends up on the page is
    // exactly what the browser rendered, nothing jsPDF reinterprets.
    await doc.html(container, {
      x: 20,
      y: 20,
      width: 555,
      windowWidth: 780,
      autoPaging: "slice",
      html2canvas: { scale: 0.72, useCORS: true, backgroundColor: "#ffffff" },
    });
    return doc;
  } finally {
    document.body.removeChild(wrapper);
  }
}
