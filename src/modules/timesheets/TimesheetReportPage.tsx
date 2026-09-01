import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router-dom";

import TimesheetRepository, { type EvidencePack, type TimesheetStatus } from "../../core/repositories/TimesheetRepository";
import EvidenceRepository from "../../core/repositories/EvidenceRepository";
import { formatMinutes, buildTimesheetPdf } from "./timesheetPdf";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import LoadingState from "../../components/common/LoadingState";
import Button from "../../components/common/Button";
import StatusBadge from "../../components/common/StatusBadge";
import styles from "./TimesheetReportPage.module.css";
import { formatDateOnly, formatDateTime, formatTimeOnly } from "../../core/utils/formatDate";

// Same domain-status -> StatusBadge tone-key mapping as TimesheetsPage
// (StatusBadge's own tone lookup only recognizes a fixed vocabulary).
const STATUS_BADGE_KEY: Record<TimesheetStatus, string> = {
  draft: "draft",
  submitted: "pending",
  approved: "approved",
  rejected: "revoked",
};

function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function buildCsv(pack: EvidencePack, languageCode: string): string {
  const lines: string[][] = [
    ["Date", "Site", "Project", "Clock In", "Clock Out", "Worked (min)", "Break (min)"],
    ...pack.entries.map((entry) => [
      formatDateOnly(entry.clockInAt, languageCode),
      entry.siteName ?? "",
      entry.projectName ?? "",
      formatTimeOnly(entry.clockInAt, languageCode),
      entry.clockOutAt ? formatTimeOnly(entry.clockOutAt, languageCode) : "",
      String(Math.round(entry.workedMinutes)),
      String(Math.round(entry.breakMinutes)),
    ]),
    [],
    ["Total Worked (min)", String(Math.round(pack.timesheet.totalWorkedMinutes))],
    ["Total Break (min)", String(Math.round(pack.timesheet.totalBreakMinutes))],
    ["Total Overtime (min)", String(Math.round(pack.timesheet.totalOvertimeMinutes))],
    ["Status", pack.timesheet.status],
    ["Approver", pack.timesheet.approverName ?? ""],
    ["Locked At", pack.timesheet.lockedAt ?? ""],
  ];
  return lines.map((row) => row.map((cell) => csvEscape(String(cell))).join(",")).join("\n");
}

function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// PROSM Time WP-17/§22 - "Monthly Evidence Pack." Real, functioning
// export mechanisms: "Export PDF" builds an actual .pdf file client-
// side (jsPDF, buildTimesheetPdf below) and downloads it directly -
// no print-dialog "choose Save as PDF" step required. Print is kept as
// a separate, secondary action for a genuine physical printer. The CSV
// button is a genuine client-built file too, satisfying "also
// exportable as spreadsheet". Bundles everything §22 names for the
// Evidence Pack - approved attendance records, GPS validation
// summaries (the geofence exceptions list), camera evidence
// references, exception reasons and approvals - in one authorized read
// (list_prosm_time_timesheet_evidence_pack).
export default function TimesheetReportPage() {
  const { t, i18n } = useTranslation("timesheets");
  const { timesheetId } = useParams<{ timesheetId: string }>();

  const [pack, setPack] = useState<EvidencePack | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!timesheetId) return;
    setLoading(true);
    setError("");
    const result = await TimesheetRepository.getEvidencePack(timesheetId);
    if (!result.success || !result.data) {
      setError(result.message ?? t("report.loadError"));
      setPack(null);
    } else {
      setPack(result.data);
    }
    setLoading(false);
  }, [timesheetId, t]);

  useEffect(() => {
    load();
  }, [load]);

  const handleExportCsv = () => {
    if (!pack) return;
    downloadCsv(`timesheet-${pack.employee.fullName.replace(/\s+/g, "-")}-${pack.timesheet.periodStart}.csv`, buildCsv(pack, i18n.language));
  };

  const handleExportPdf = () => {
    if (!pack) return;
    const doc = buildTimesheetPdf(pack, i18n.language, t);
    doc.save(`timesheet-${pack.employee.fullName.replace(/\s+/g, "-")}-${pack.timesheet.periodStart}.pdf`);
  };

  const handleViewEvidence = async (storagePath: string) => {
    const result = await EvidenceRepository.getEvidenceObjectUrl(storagePath);
    if (result.success && result.data) {
      window.open(result.data, "_blank", "noopener,noreferrer");
    }
  };

  if (loading) {
    return (
      <PageShell title={t("report.title")}>
        <LoadingState fullHeight />
      </PageShell>
    );
  }

  if (error || !pack) {
    return (
      <PageShell title={t("report.title")}>
        <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{error || t("report.loadError")}</p>
        <Link to="/timesheets">{t("report.backLink")}</Link>
      </PageShell>
    );
  }

  return (
    <PageShell
      title={t("report.title")}
      subtitle={`${pack.employee.fullName} — ${pack.timesheet.periodStart} — ${pack.timesheet.periodEnd}`}
      actions={
        <div className={styles.noPrint} style={{ display: "flex", gap: "var(--space-2)" }}>
          <Link to="/timesheets">
            <Button variant="ghost" size="sm">
              {t("report.backLink")}
            </Button>
          </Link>
          <Button variant="ghost" size="sm" onClick={handleExportCsv}>
            {t("report.exportCsvAction")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => window.print()}>
            {t("report.printAction")}
          </Button>
          <Button size="sm" onClick={handleExportPdf}>
            {t("report.exportPdfAction")}
          </Button>
        </div>
      }
    >
      <Card title={t("report.summaryTitle")}>
        <div className={styles.summaryGrid}>
          <div className={styles.summaryItem}>
            {t("report.organization")}
            <span className={styles.summaryValue}>
              {pack.organization.name} ({pack.organization.organizationCode})
            </span>
          </div>
          <div className={styles.summaryItem}>
            {t("report.employee")}
            <span className={styles.summaryValue}>{pack.employee.fullName}</span>
          </div>
          <div className={styles.summaryItem}>
            {t("report.status")}
            <span className={styles.summaryValue}>
              <StatusBadge status={STATUS_BADGE_KEY[pack.timesheet.status]}>{t(`status.${pack.timesheet.status}`)}</StatusBadge>
            </span>
          </div>
          <div className={styles.summaryItem}>
            {t("report.worked")}
            <span className={styles.summaryValue}>{formatMinutes(pack.timesheet.totalWorkedMinutes)}</span>
          </div>
          <div className={styles.summaryItem}>
            {t("report.breaks")}
            <span className={styles.summaryValue}>{formatMinutes(pack.timesheet.totalBreakMinutes)}</span>
          </div>
          <div className={styles.summaryItem}>
            {t("report.overtime")}
            <span className={styles.summaryValue}>{formatMinutes(pack.timesheet.totalOvertimeMinutes)}</span>
          </div>
          <div className={styles.summaryItem}>
            {t("report.approver")}
            <span className={styles.summaryValue}>{pack.timesheet.approverName ?? "—"}</span>
          </div>
          <div className={styles.summaryItem}>
            {t("report.approvedAt")}
            <span className={styles.summaryValue}>{pack.timesheet.approvedAt ? formatDateTime(pack.timesheet.approvedAt, i18n.language) : "—"}</span>
          </div>
          <div className={styles.summaryItem}>
            {t("report.lockStatus")}
            <span className={styles.summaryValue}>{pack.timesheet.lockedAt ? t("report.locked") : t("report.unlocked")}</span>
          </div>
        </div>
      </Card>

      <Card title={t("report.entriesTitle")}>
        {pack.entries.length === 0 ? (
          <p className={styles.emptyRow}>{t("detail.noEntries")}</p>
        ) : (
          pack.entries.map((entry) => (
            <div key={entry.sessionId} className={styles.row}>
              <span>{formatDateTime(entry.clockInAt, i18n.language)}</span>
              <span>{entry.clockOutAt ? formatTimeOnly(entry.clockOutAt, i18n.language) : t("detail.stillOpen")}</span>
              <span>{entry.siteName ?? "—"}</span>
              <span>{entry.projectName ?? "—"}</span>
              <span>{formatMinutes(entry.workedMinutes)}</span>
            </div>
          ))
        )}
      </Card>

      <Card title={t("report.exceptionsTitle")}>
        {pack.exceptions.length === 0 ? (
          <p className={styles.emptyRow}>{t("report.noExceptions")}</p>
        ) : (
          pack.exceptions.map((exception) => (
            <div key={exception.id} className={styles.row}>
              <span>{formatDateTime(exception.createdAt, i18n.language)}</span>
              <span>{Math.round(exception.distanceMeters)} m</span>
              <span>{exception.reasonCategory ?? "—"}</span>
              <span>{exception.employeeReason ?? "—"}</span>
              <span>{exception.status}</span>
            </div>
          ))
        )}
      </Card>

      <Card title={t("report.correctionsTitle")}>
        {pack.corrections.length === 0 && pack.timesheetCorrections.length === 0 ? (
          <p className={styles.emptyRow}>{t("report.noCorrections")}</p>
        ) : (
          <>
            {pack.corrections.map((correction) => (
              <div key={correction.id} className={styles.row}>
                <span>{formatDateTime(correction.createdAt, i18n.language)}</span>
                <span>{correction.proposedEventType}</span>
                <span>{correction.reason}</span>
                <span>{correction.status}</span>
              </div>
            ))}
            {pack.timesheetCorrections.map((correction) => (
              <div key={correction.id} className={styles.row}>
                <span>{formatDateTime(correction.createdAt, i18n.language)}</span>
                <span>{t("report.timesheetLevelCorrection")}</span>
                <span>{correction.reason}</span>
                <span>{correction.status}</span>
              </div>
            ))}
          </>
        )}
      </Card>

      <Card title={t("report.evidenceTitle")}>
        {pack.evidenceReferences.length === 0 ? (
          <p className={styles.emptyRow}>{t("report.noEvidence")}</p>
        ) : (
          pack.evidenceReferences.map((evidence) => (
            <div key={evidence.id} className={styles.row}>
              <span>{formatDateTime(evidence.capturedAt, i18n.language)}</span>
              <span>{evidence.contentType}</span>
              <button type="button" className={styles.noPrint} onClick={() => handleViewEvidence(evidence.storagePath)} style={{ background: "none", border: "none", color: "var(--text-link)", cursor: "pointer", padding: 0, font: "inherit" }}>
                {t("report.viewEvidence")}
              </button>
            </div>
          ))
        )}
      </Card>

      <Card title={t("report.approvalTrailTitle")}>
        {pack.approvalTrail.length === 0 ? (
          <p className={styles.emptyRow}>{t("report.noApprovalTrail")}</p>
        ) : (
          pack.approvalTrail.map((row, index) => (
            <div key={index} className={styles.row}>
              <span>{formatDateTime(row.createdAt, i18n.language)}</span>
              <span>{row.actorName}</span>
              <span>{row.action}</span>
              <span>{row.notes ?? "—"}</span>
            </div>
          ))
        )}
      </Card>
    </PageShell>
  );
}
