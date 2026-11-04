import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../core/context/AuthContext";
import usePlanFeatures from "../../core/hooks/usePlanFeatures";
import { Link, useParams } from "react-router-dom";

import TimesheetRepository, { type EvidencePack, type TimesheetStatus } from "../../core/repositories/TimesheetRepository";
import EvidenceRepository from "../../core/repositories/EvidenceRepository";
import OrganizationRepository from "../../core/repositories/OrganizationRepository";
import { buildTimesheetPdf } from "./timesheetPdf";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import savePdfDocument, { printPdfDocument } from "../../core/utils/savePdfDocument";
import saveGeneratedFile from "../../core/utils/saveGeneratedFile";

import PageShell from "../../components/common/PageShell";
import Table from "../../components/common/Table";
import Card from "../../components/common/Card";
import LoadingState from "../../components/common/LoadingState";
import Button from "../../components/common/Button";
import StatusBadge from "../../components/common/StatusBadge";
import ErrorText from "../../components/common/ErrorText";
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

// Hours and minutes as 6:09, readable in every language without a unit letter.
function hoursAndMinutes(minutes: number): string {
  const total = Math.round(minutes);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

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
  saveGeneratedFile(filename, new Blob([content], { type: "text/csv;charset=utf-8;" }));
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
  const { profile } = useAuth();
  const { allows } = usePlanFeatures(profile?.id);
  const { timesheetId } = useParams<{ timesheetId: string }>();

  const [pack, setPack] = useState<EvidencePack | null>(null);
  const [organizationLogoUrl, setOrganizationLogoUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exportingPdf, setExportingPdf] = useState(false);

  const load = useCallback(async () => {
    if (!timesheetId) return;
    setLoading(true);
    setError("");
    const [result, organizationResult] = await Promise.all([TimesheetRepository.getEvidencePack(timesheetId), OrganizationRepository.getCurrentOrganization()]);
    if (!result.success || !result.data) {
      setError(humanizeBackendError(result.message, t) ?? t("report.loadError"));
      setPack(null);
    } else {
      setPack(result.data);
    }
    setOrganizationLogoUrl(organizationResult.success ? organizationResult.data?.logoUrl ?? null : null);
    setLoading(false);
  }, [timesheetId, t]);

  useEffect(() => {
    load();
  }, [load]);

  const handleExportCsv = () => {
    if (!pack) return;
    downloadCsv(`timesheet-${pack.employee.fullName.replace(/\s+/g, "-")}-${pack.timesheet.periodStart}.csv`, buildCsv(pack, i18n.language));
  };

  const handleExportPdf = async (mode: "save" | "print" = "save") => {
    if (!pack) return;
    setExportingPdf(true);
    try {
      const doc = await buildTimesheetPdf(pack, i18n.language, t, organizationLogoUrl);
      const filename = `timesheet-${pack.employee.fullName.replace(/\s+/g, "-")}-${pack.timesheet.periodStart}.pdf`;
      if (mode === "print") await printPdfDocument(doc, filename);
      else await savePdfDocument(doc, filename, "timesheet", pack.timesheet.periodStart, pack.timesheet.periodEnd);
    } finally {
      setExportingPdf(false);
    }
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
        <ErrorText>{error || t("report.loadError")}</ErrorText>
        <Link to="/timesheets">{t("report.backLink")}</Link>
      </PageShell>
    );
  }

  return (
    <PageShell
      title={t("report.title")}
      subtitle={`${pack.employee.fullName} · ${formatDateOnly(pack.timesheet.periodStart, i18n.language)} – ${formatDateOnly(pack.timesheet.periodEnd, i18n.language)}`}
      actions={
        <div className={styles.noPrint} style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
          <Link to="/timesheets">
            <Button variant="ghost" size="sm">
              {t("report.backLink")}
            </Button>
          </Link>
          <Button variant="ghost" size="sm" onClick={handleExportCsv} disabled={!allows("export")} title={allows("export") ? undefined : t("common:planLocked.text", { plan: "Business" })}>
            {t("report.exportCsvAction")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => handleExportPdf("print")} loading={exportingPdf} disabled={!allows("export")} title={allows("export") ? undefined : t("common:planLocked.text", { plan: "Business" })}>
            {t("common:actions.print")}
          </Button>
          <Button size="sm" onClick={() => handleExportPdf()} loading={exportingPdf} disabled={!allows("export")} title={allows("export") ? undefined : t("common:planLocked.text", { plan: "Business" })}>
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
            <span className={styles.summaryValue}>{hoursAndMinutes(pack.timesheet.totalWorkedMinutes)}</span>
          </div>
          <div className={styles.summaryItem}>
            {t("report.breaks")}
            <span className={styles.summaryValue}>{hoursAndMinutes(pack.timesheet.totalBreakMinutes)}</span>
          </div>
          <div className={styles.summaryItem}>
            {t("report.overtime")}
            <span className={styles.summaryValue}>{hoursAndMinutes(pack.timesheet.totalOvertimeMinutes)}</span>
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
        <Table
          grid
          columns={[
            { key: "in", header: t("report.columns.clockIn"), render: (entry) => formatDateTime(entry.clockInAt, i18n.language) },
            { key: "out", header: t("report.columns.clockOut"), render: (entry) => (entry.clockOutAt ? formatTimeOnly(entry.clockOutAt, i18n.language) : t("detail.stillOpen")) },
            { key: "site", header: t("report.columns.site"), render: (entry) => entry.siteName ?? "—" },
            { key: "project", header: t("report.columns.project"), render: (entry) => entry.projectName ?? "—" },
            { key: "worked", header: t("report.worked"), render: (entry) => <span style={{ whiteSpace: "nowrap" }}>{hoursAndMinutes(entry.workedMinutes)}</span> },
          ]}
          data={pack.entries}
          getRowId={(entry) => entry.sessionId}
          emptyMessage={t("detail.noEntries")}
        />
      </Card>

      <Card title={t("report.exceptionsTitle")}>
        <Table
          grid
          columns={[
            { key: "when", header: t("report.columns.when"), render: (exception) => formatDateTime(exception.createdAt, i18n.language) },
            { key: "distance", header: t("report.columns.distance"), render: (exception) => <span style={{ whiteSpace: "nowrap" }}>{t("report.meters", { value: Math.round(exception.distanceMeters) })}</span> },
            { key: "category", header: t("report.columns.category"), render: (exception) => (exception.reasonCategory ? t(`dashboard:exceptions.category.${exception.reasonCategory}`, { defaultValue: exception.reasonCategory }) : "—") },
            { key: "reason", header: t("report.columns.reason"), render: (exception) => exception.employeeReason ?? "—" },
            { key: "status", header: t("report.status"), render: (exception) => t(`reports:columns.locationViolations.statuses.${exception.status}`, { defaultValue: exception.status }) },
          ]}
          data={pack.exceptions}
          getRowId={(exception) => exception.id}
          emptyMessage={t("report.noExceptions")}
        />
      </Card>

      <Card title={t("report.correctionsTitle")}>
        <Table
          grid
          columns={[
            { key: "when", header: t("report.columns.when"), render: (row) => formatDateTime(row.createdAt, i18n.language) },
            { key: "kind", header: t("report.columns.kind"), render: (row) => row.kind },
            { key: "reason", header: t("report.columns.reason"), render: (row) => row.reason },
            { key: "status", header: t("report.status"), render: (row) => t(`reports:columns.locationViolations.statuses.${row.status}`, { defaultValue: t(`status.${row.status}`, { defaultValue: row.status }) }) },
          ]}
          data={[
            ...pack.corrections.map((correction) => ({
              id: correction.id,
              createdAt: correction.createdAt,
              kind: correction.proposedEventType === "clock_out" ? t("report.columns.clockOut") : correction.proposedEventType === "clock_in" ? t("report.columns.clockIn") : correction.proposedEventType,
              reason: correction.reason,
              status: correction.status,
            })),
            ...pack.timesheetCorrections.map((correction) => ({ id: correction.id, createdAt: correction.createdAt, kind: t("report.timesheetLevelCorrection"), reason: correction.reason, status: correction.status })),
          ]}
          getRowId={(row) => row.id}
          emptyMessage={t("report.noCorrections")}
        />
      </Card>

      <Card title={t("report.evidenceTitle")}>
        <Table
          grid
          columns={[
            { key: "when", header: t("report.columns.when"), render: (evidence) => formatDateTime(evidence.capturedAt, i18n.language) },
            { key: "type", header: t("report.columns.kind"), render: (evidence) => (evidence.contentType.startsWith("image/") ? t("report.photo") : evidence.contentType) },
            {
              key: "view",
              header: "",
              render: (evidence) => (
                <button type="button" className={styles.noPrint} onClick={() => handleViewEvidence(evidence.storagePath)} style={{ background: "none", border: "none", color: "var(--text-link)", cursor: "pointer", padding: 0, font: "inherit" }}>
                  {t("report.viewEvidence")}
                </button>
              ),
            },
          ]}
          data={pack.evidenceReferences}
          getRowId={(evidence) => evidence.id}
          emptyMessage={t("report.noEvidence")}
        />
      </Card>

      <Card title={t("report.approvalTrailTitle")}>
        <Table
          grid
          columns={[
            { key: "when", header: t("report.columns.when"), render: (row) => formatDateTime(row.createdAt, i18n.language) },
            { key: "actor", header: t("report.approver"), render: (row) => row.actorName },
            { key: "action", header: t("report.columns.action"), render: (row) => t(`status.${row.action}`, { defaultValue: row.action }) },
            { key: "notes", header: t("report.columns.notes"), render: (row) => row.notes ?? "—" },
          ]}
          data={pack.approvalTrail.map((row, index) => ({ ...row, id: String(index) }))}
          getRowId={(row) => row.id}
          emptyMessage={t("report.noApprovalTrail")}
        />
      </Card>
    </PageShell>
  );
}
