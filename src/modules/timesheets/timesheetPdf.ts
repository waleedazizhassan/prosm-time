import { jsPDF } from "jspdf";
import type { EvidencePack } from "../../core/repositories/TimesheetRepository";
import { formatDateTime, formatTimeOnly } from "../../core/utils/formatDate";

export function formatMinutes(minutes: number): string {
  const totalMinutes = Math.round(minutes);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return `${hours}h ${mins}m`;
}

// § final visual consistency pass, correction - "The Timesheet Report
// must provide an actual PDF output... verify the PDF action actually
// generates/downloads a valid PDF file." A real client-built PDF
// (jsPDF - the only new dependency this pass adds, no backend/service
// involved) rather than relying on the browser's print dialog's own
// manual "destination: Save as PDF" step.
//
// § live UX review - extracted out of TimesheetReportPage so
// TimesheetsPage's own list can export a PDF directly per row too,
// without navigating into the detail report first (one function, two
// entry points - not a second PDF implementation).
export function buildTimesheetPdf(pack: EvidencePack, languageCode: string, t: (key: string, options?: Record<string, unknown>) => string): jsPDF {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const marginX = 40;
  const pageHeight = doc.internal.pageSize.getHeight();
  const pageWidth = doc.internal.pageSize.getWidth();
  let y = 48;

  const ensureSpace = (needed: number) => {
    if (y + needed > pageHeight - 40) {
      doc.addPage();
      y = 48;
    }
  };

  const heading = (text: string) => {
    ensureSpace(28);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text(text.toUpperCase(), marginX, y);
    y += 6;
    doc.setDrawColor(200);
    doc.line(marginX, y, pageWidth - marginX, y);
    y += 16;
  };

  const line = (text: string, options?: { bold?: boolean; size?: number }) => {
    ensureSpace(16);
    doc.setFont("helvetica", options?.bold ? "bold" : "normal");
    doc.setFontSize(options?.size ?? 10);
    const wrapped = doc.splitTextToSize(text, pageWidth - marginX * 2);
    doc.text(wrapped, marginX, y);
    y += 14 * wrapped.length;
  };

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(t("report.title"), marginX, y);
  y += 22;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(`${pack.employee.fullName} — ${pack.timesheet.periodStart} — ${pack.timesheet.periodEnd}`, marginX, y);
  y += 24;

  heading(t("report.summaryTitle"));
  line(`${t("report.organization")}: ${pack.organization.name} (${pack.organization.organizationCode})`);
  line(`${t("report.employee")}: ${pack.employee.fullName} (${pack.employee.email})`);
  line(`${t("report.status")}: ${t(`status.${pack.timesheet.status}`)}`);
  line(`${t("report.worked")}: ${formatMinutes(pack.timesheet.totalWorkedMinutes)}    ${t("report.breaks")}: ${formatMinutes(pack.timesheet.totalBreakMinutes)}    ${t("report.overtime")}: ${formatMinutes(pack.timesheet.totalOvertimeMinutes)}`);
  line(`${t("report.approver")}: ${pack.timesheet.approverName ?? "—"}`);
  line(`${t("report.approvedAt")}: ${pack.timesheet.approvedAt ? formatDateTime(pack.timesheet.approvedAt, languageCode) : "—"}`);
  line(`${t("report.lockStatus")}: ${pack.timesheet.lockedAt ? t("report.locked") : t("report.unlocked")}`);
  y += 8;

  heading(t("report.entriesTitle"));
  if (pack.entries.length === 0) {
    line(t("detail.noEntries"));
  } else {
    pack.entries.forEach((entry) => {
      line(
        `${formatDateTime(entry.clockInAt, languageCode)} → ${entry.clockOutAt ? formatTimeOnly(entry.clockOutAt, languageCode) : t("detail.stillOpen")}  ·  ${entry.siteName ?? "—"}${entry.projectName ? ` · ${entry.projectName}` : ""}  ·  ${formatMinutes(entry.workedMinutes)}`,
      );
    });
  }
  y += 8;

  heading(t("report.exceptionsTitle"));
  if (pack.exceptions.length === 0) {
    line(t("report.noExceptions"));
  } else {
    pack.exceptions.forEach((exception) => {
      line(`${formatDateTime(exception.createdAt, languageCode)}  ·  ${Math.round(exception.distanceMeters)} m  ·  ${exception.reasonCategory ?? "—"}  ·  ${exception.employeeReason ?? "—"}  ·  ${exception.status}`);
    });
  }
  y += 8;

  heading(t("report.correctionsTitle"));
  if (pack.corrections.length === 0 && pack.timesheetCorrections.length === 0) {
    line(t("report.noCorrections"));
  } else {
    pack.corrections.forEach((correction) => {
      line(`${formatDateTime(correction.createdAt, languageCode)}  ·  ${correction.proposedEventType}  ·  ${correction.reason}  ·  ${correction.status}`);
    });
    pack.timesheetCorrections.forEach((correction) => {
      line(`${formatDateTime(correction.createdAt, languageCode)}  ·  ${t("report.timesheetLevelCorrection")}  ·  ${correction.reason}  ·  ${correction.status}`);
    });
  }
  y += 8;

  heading(t("report.evidenceTitle"));
  if (pack.evidenceReferences.length === 0) {
    line(t("report.noEvidence"));
  } else {
    pack.evidenceReferences.forEach((evidence) => {
      line(`${formatDateTime(evidence.capturedAt, languageCode)}  ·  ${evidence.contentType}`);
    });
  }
  y += 8;

  heading(t("report.approvalTrailTitle"));
  if (pack.approvalTrail.length === 0) {
    line(t("report.noApprovalTrail"));
  } else {
    pack.approvalTrail.forEach((row) => {
      line(`${formatDateTime(row.createdAt, languageCode)}  ·  ${row.actorName}  ·  ${row.action}  ·  ${row.notes ?? "—"}`);
    });
  }

  return doc;
}
