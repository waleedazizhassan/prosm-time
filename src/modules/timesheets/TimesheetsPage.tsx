import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Download, Camera } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import TimesheetRepository, { type Timesheet, type TimesheetEntry, type TimesheetCorrection } from "../../core/repositories/TimesheetRepository";
import EmployeeRepository, { type OrgMember } from "../../core/repositories/EmployeeRepository";
import EvidenceRepository from "../../core/repositories/EvidenceRepository";
import { formatMinutes, buildTimesheetPdf } from "./timesheetPdf";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import Table, { type TableColumn } from "../../components/common/Table";
import StatusBadge from "../../components/common/StatusBadge";
import Button from "../../components/common/Button";
import Select from "../../components/common/Select";
import Input from "../../components/common/Input";
import Modal from "../../components/common/Modal";
import Textarea from "../../components/common/Textarea";
import LoadingState from "../../components/common/LoadingState";
import EmptyState from "../../components/common/EmptyState";
import ListRow from "../../components/common/ListRow";
import FormGrid from "../../components/common/FormGrid";
import { formatDateTime, formatTimeOnly } from "../../core/utils/formatDate";

function toDateInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function defaultPeriod(): { start: string; end: string } {
  const now = new Date();
  return {
    start: toDateInput(new Date(now.getFullYear(), now.getMonth(), 1)),
    end: toDateInput(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
  };
}

// StatusBadge's own tone lookup only recognizes a fixed vocabulary of
// status words (see StatusBadge.tsx) - map this domain's own status
// values onto the closest existing tone key rather than duplicating a
// second tone table here.
const STATUS_BADGE_KEY: Record<Timesheet["status"], string> = {
  draft: "draft",
  submitted: "pending",
  approved: "approved",
  rejected: "revoked",
};

// PROSM Time WP-16/§22 - "Timesheet & Monthly Evidence Pack." Row:
// "Period calculation, review, approval, locking and correction."
// PDF/spreadsheet export and the Monthly Evidence Pack are WP-17's own
// later row - this page is the real generate/review/approve/correct
// workflow the export will eventually read from, not a placeholder.
export default function TimesheetsPage() {
  const { t, i18n } = useTranslation("timesheets");
  const { profile, hasPermission } = useAuth();

  const canGenerate = hasPermission("timesheets.generate");
  const canApprove = hasPermission("timesheets.approve");
  const canCorrect = hasPermission("attendance.correct");

  const [myTimesheets, setMyTimesheets] = useState<Timesheet[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<Timesheet[]>([]);
  const [pendingCorrections, setPendingCorrections] = useState<TimesheetCorrection[]>([]);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [generateUserId, setGenerateUserId] = useState("");
  const [period, setPeriod] = useState(defaultPeriod());
  const [generating, setGenerating] = useState(false);

  const [detailTimesheet, setDetailTimesheet] = useState<Timesheet | null>(null);
  const [entries, setEntries] = useState<TimesheetEntry[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [actionSubmitting, setActionSubmitting] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [reviewNotes, setReviewNotes] = useState("");
  const [showCorrectionForm, setShowCorrectionForm] = useState(false);
  const [correctionReason, setCorrectionReason] = useState("");

  const [correctionReviewTarget, setCorrectionReviewTarget] = useState<TimesheetCorrection | null>(null);
  const [correctionReviewNotes, setCorrectionReviewNotes] = useState("");
  const [correctionReviewSubmitting, setCorrectionReviewSubmitting] = useState<string | null>(null);

  const [exportingId, setExportingId] = useState<string | null>(null);

  const [evidenceModalTitle, setEvidenceModalTitle] = useState<string | null>(null);
  const [evidenceUrl, setEvidenceUrl] = useState<string | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState("");

  const load = useCallback(async () => {
    if (!profile) return;
    setLoading(true);
    setError("");

    const [myResult, approvalsResult, correctionsResult, membersResult] = await Promise.all([
      TimesheetRepository.listMyTimesheets(profile.id),
      canApprove ? TimesheetRepository.listPendingApprovals() : Promise.resolve({ success: true, message: null, data: [] as Timesheet[] }),
      canCorrect ? TimesheetRepository.listPendingCorrections() : Promise.resolve({ success: true, message: null, data: [] as TimesheetCorrection[] }),
      canGenerate ? EmployeeRepository.listOrganizationMembers() : Promise.resolve({ success: true, message: null, data: [] as OrgMember[] }),
    ]);

    // § live UX review, user-directed - "Timesheets shows no data" kept
    // recurring with no visible cause. Root gap found on inspection: a
    // failed fetch here (RLS, network, session) was silently treated
    // the same as "genuinely empty" - defaulting to [] with nothing
    // ever surfaced to the user or to us. Any real failure is now
    // shown, so a future recurrence reports its actual cause instead of
    // looking identical to "no data".
    const failures = [myResult, approvalsResult, correctionsResult, membersResult].filter((result) => !result.success);
    if (failures.length > 0) {
      setError(failures.map((result) => result.message).filter(Boolean).join(" · ") || t("loadError"));
    }

    setMyTimesheets(myResult.success ? myResult.data ?? [] : []);
    setPendingApprovals(approvalsResult.success ? approvalsResult.data ?? [] : []);
    setPendingCorrections(correctionsResult.success ? correctionsResult.data ?? [] : []);
    const memberList = membersResult.success ? membersResult.data ?? [] : [];
    setMembers(memberList);
    setGenerateUserId((current) => current || memberList[0]?.id || "");
    setLoading(false);
  }, [profile, canApprove, canCorrect, canGenerate, t]);

  useEffect(() => {
    load();
  }, [load]);

  const handleGenerate = async () => {
    if (!generateUserId) return;
    setGenerating(true);
    setError("");
    const result = await TimesheetRepository.generateTimesheet(generateUserId, period.start, period.end);
    setGenerating(false);
    if (!result.success) {
      setError(result.message ?? t("generateError"));
      return;
    }
    load();
  };

  // § live UX review, user-directed - "no button to view the clock-in/
  // clock-out photo" in Timesheets itself, matching the same feature
  // already built into Manager Console (§ ManagerConsolePage's own
  // identical openEvidence/closeEvidence pair).
  const openEvidence = async (storagePath: string, title: string) => {
    setEvidenceModalTitle(title);
    setEvidenceUrl(null);
    setEvidenceError("");
    setEvidenceLoading(true);
    const result = await EvidenceRepository.getEvidenceObjectUrl(storagePath);
    setEvidenceLoading(false);
    if (!result.success || !result.data) {
      setEvidenceError(result.message ?? t("photoLoadError"));
      return;
    }
    setEvidenceUrl(result.data);
  };

  const closeEvidence = () => {
    if (evidenceUrl) URL.revokeObjectURL(evidenceUrl);
    setEvidenceModalTitle(null);
    setEvidenceUrl(null);
    setEvidenceError("");
  };

  const openDetail = async (timesheet: Timesheet) => {
    setDetailTimesheet(timesheet);
    setEntries([]);
    setDetailError("");
    setReviewNotes("");
    setShowCorrectionForm(false);
    setCorrectionReason("");
    setEntriesLoading(true);
    const result = await TimesheetRepository.getEntries(timesheet.id);
    setEntries(result.success ? result.data ?? [] : []);
    setEntriesLoading(false);
  };

  const closeDetail = () => {
    setDetailTimesheet(null);
  };

  const handleSubmitTimesheet = async () => {
    if (!detailTimesheet) return;
    setActionSubmitting(true);
    setDetailError("");
    const result = await TimesheetRepository.submitTimesheet(detailTimesheet.id);
    setActionSubmitting(false);
    if (!result.success) {
      setDetailError(result.message ?? t("submitError"));
      return;
    }
    closeDetail();
    load();
  };

  const handleApproveTimesheet = async (action: "approved" | "rejected") => {
    if (!detailTimesheet) return;
    setActionSubmitting(true);
    setDetailError("");
    const result = await TimesheetRepository.approveTimesheet(detailTimesheet.id, action, reviewNotes.trim() || undefined);
    setActionSubmitting(false);
    if (!result.success) {
      setDetailError(result.message ?? t("approveError"));
      return;
    }
    closeDetail();
    load();
  };

  const handleRequestCorrection = async () => {
    if (!detailTimesheet || !correctionReason.trim()) return;
    setActionSubmitting(true);
    setDetailError("");
    const result = await TimesheetRepository.requestCorrection(detailTimesheet.id, correctionReason.trim());
    setActionSubmitting(false);
    if (!result.success) {
      setDetailError(result.message ?? t("correctionRequestError"));
      return;
    }
    closeDetail();
    load();
  };

  const handleReviewCorrection = async (action: "approved" | "rejected") => {
    if (!correctionReviewTarget) return;
    setCorrectionReviewSubmitting(action);
    setError("");
    const result = await TimesheetRepository.reviewCorrection(correctionReviewTarget.id, action, correctionReviewNotes.trim() || undefined);
    setCorrectionReviewSubmitting(null);
    if (!result.success) {
      setError(result.message ?? t("correctionReviewError"));
      return;
    }
    setCorrectionReviewTarget(null);
    setCorrectionReviewNotes("");
    load();
  };

  // § live UX review, user-directed - "make sure PDF data export is
  // available" on the Timesheets list itself, not only after clicking
  // into a specific timesheet's own Report page. Reuses the exact same
  // buildTimesheetPdf/getEvidencePack path TimesheetReportPage already
  // uses - one PDF implementation, two entry points.
  const handleExportPdf = async (event: ReactMouseEvent, row: Timesheet) => {
    event.stopPropagation();
    setExportingId(row.id);
    const result = await TimesheetRepository.getEvidencePack(row.id);
    setExportingId(null);
    if (!result.success || !result.data) {
      setError(result.message ?? t("report.loadError"));
      return;
    }
    const doc = buildTimesheetPdf(result.data, i18n.language, t);
    doc.save(`timesheet-${row.userFullName.replace(/\s+/g, "-")}-${row.periodStart}.pdf`);
  };

  const timesheetColumns = (showEmployee: boolean): TableColumn<Timesheet>[] => [
    ...(showEmployee ? [{ key: "employee", header: t("columns.employee"), render: (row: Timesheet) => row.userFullName } as TableColumn<Timesheet>] : []),
    { key: "period", header: t("columns.period"), render: (row) => `${row.periodStart} — ${row.periodEnd}` },
    { key: "status", header: t("columns.status"), render: (row) => <StatusBadge status={STATUS_BADGE_KEY[row.status]}>{t(`status.${row.status}`)}</StatusBadge> },
    { key: "worked", header: t("columns.worked"), render: (row) => formatMinutes(row.totalWorkedMinutes) },
    { key: "overtime", header: t("columns.overtime"), render: (row) => formatMinutes(row.totalOvertimeMinutes) },
    {
      key: "exportPdf",
      header: t("columns.export"),
      render: (row) => (
        <Button variant="ghost" size="xs" onClick={(event) => handleExportPdf(event, row)} loading={exportingId === row.id}>
          <Download size={13} /> {t("report.exportPdfAction")}
        </Button>
      ),
    },
  ];

  const isOwnDetail = detailTimesheet && profile ? detailTimesheet.userId === profile.id : false;
  const canReviewDetail = detailTimesheet ? !isOwnDetail && detailTimesheet.status === "submitted" && canApprove : false;
  const canSubmitDetail = detailTimesheet ? isOwnDetail && detailTimesheet.status === "draft" : false;
  const canRequestCorrectionDetail = detailTimesheet ? isOwnDetail && detailTimesheet.status === "approved" : false;

  return (
    <PageShell title={t("title")} subtitle={t("subtitle")}>
      {error ? <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{error}</p> : null}

      {canGenerate ? (
        <Card title={t("generate.title")}>
          <FormGrid columns={4} gap="sm" alignItems="end">
            {/* § live UX review - two accounts with near-identical names
                ("waleed" / "WALEED AZIZ") led to a timesheet being
                generated for the wrong one (confirmed by querying the
                live database directly - a real draft timesheet existed
                for the selected user, correctly showing 0 worked
                minutes, because THAT account had never actually
                clocked in). Email now disambiguates every option. */}
            <Select
              label={t("generate.employeeLabel")}
              name="generateUserId"
              value={generateUserId}
              onChange={(event) => setGenerateUserId(event.target.value)}
              options={members.map((member) => ({ value: member.id, label: `${member.fullName} (${member.email})` }))}
              disabled={generating}
            />
            <Input label={t("generate.periodStartLabel")} name="periodStart" type="date" value={period.start} onChange={(event) => setPeriod((current) => ({ ...current, start: event.target.value }))} disabled={generating} />
            <Input label={t("generate.periodEndLabel")} name="periodEnd" type="date" value={period.end} onChange={(event) => setPeriod((current) => ({ ...current, end: event.target.value }))} disabled={generating} />
            <Button onClick={handleGenerate} loading={generating} disabled={!generateUserId}>
              {t("generate.action")}
            </Button>
          </FormGrid>
        </Card>
      ) : null}

      {canApprove ? (
        <Card title={t("pendingApprovals.title")}>
          <Table columns={timesheetColumns(true)} data={pendingApprovals} getRowId={(row) => row.id} loading={loading} emptyMessage={t("pendingApprovals.empty")} onRowClick={openDetail} />
        </Card>
      ) : null}

      {canCorrect ? (
        <Card title={t("pendingCorrections.title")}>
          {pendingCorrections.length === 0 ? (
            <EmptyState message={t("pendingCorrections.empty")} />
          ) : (
            pendingCorrections.map((correction) => (
              <ListRow key={correction.id}>
                <div>
                  <div style={{ fontSize: "var(--font-sm)", color: "var(--text-primary)", fontWeight: "var(--font-weight-semibold)" }}>
                    {correction.userFullName} — {correction.periodStart} — {correction.periodEnd}
                  </div>
                  <div style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{correction.reason}</div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setCorrectionReviewTarget(correction)}>
                  {t("pendingCorrections.reviewAction")}
                </Button>
              </ListRow>
            ))
          )}
        </Card>
      ) : null}

      <Card title={t("myTimesheets.title")}>
        <Table columns={timesheetColumns(false)} data={myTimesheets} getRowId={(row) => row.id} loading={loading} emptyMessage={t("myTimesheets.empty")} onRowClick={openDetail} />
      </Card>

      <Modal
        isOpen={Boolean(detailTimesheet)}
        onClose={closeDetail}
        title={detailTimesheet ? `${detailTimesheet.userFullName} — ${detailTimesheet.periodStart} — ${detailTimesheet.periodEnd}` : ""}
        footer={
          detailTimesheet ? (
            <>
              <Link to={`/timesheets/${detailTimesheet.id}/report`}>
                <Button variant="ghost">{t("detail.viewReportAction")}</Button>
              </Link>
              {canSubmitDetail ? (
                <Button onClick={handleSubmitTimesheet} loading={actionSubmitting}>
                  {t("detail.submitAction")}
                </Button>
              ) : null}
              {canReviewDetail ? (
                <>
                  <Button variant="ghost" onClick={() => handleApproveTimesheet("rejected")} loading={actionSubmitting}>
                    {t("detail.rejectAction")}
                  </Button>
                  <Button onClick={() => handleApproveTimesheet("approved")} loading={actionSubmitting}>
                    {t("detail.approveAction")}
                  </Button>
                </>
              ) : null}
              {canRequestCorrectionDetail && !showCorrectionForm ? (
                <Button variant="ghost" onClick={() => setShowCorrectionForm(true)}>
                  {t("detail.requestCorrectionAction")}
                </Button>
              ) : null}
              {canRequestCorrectionDetail && showCorrectionForm ? (
                <Button onClick={handleRequestCorrection} loading={actionSubmitting} disabled={!correctionReason.trim()}>
                  {t("detail.submitCorrectionAction")}
                </Button>
              ) : null}
            </>
          ) : null
        }
      >
        {detailTimesheet ? (
          <>
            {detailError ? <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{detailError}</p> : null}
            <dl style={{ margin: "0 0 var(--space-4)", fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
              <dd style={{ margin: "0 0 var(--space-1)" }}>
                {t("detail.status")}: <StatusBadge status={STATUS_BADGE_KEY[detailTimesheet.status]}>{t(`status.${detailTimesheet.status}`)}</StatusBadge>
              </dd>
              <dd style={{ margin: "0 0 var(--space-1)" }}>
                {t("detail.worked")}: {formatMinutes(detailTimesheet.totalWorkedMinutes)} · {t("detail.breaks")}: {formatMinutes(detailTimesheet.totalBreakMinutes)} · {t("detail.overtime")}: {formatMinutes(detailTimesheet.totalOvertimeMinutes)}
              </dd>
              <dd style={{ margin: 0 }}>
                {t("detail.exceptions")}: {detailTimesheet.exceptionsCount} · {t("detail.corrections")}: {detailTimesheet.correctionsCount}
              </dd>
            </dl>

            {entriesLoading ? (
              <LoadingState size="sm" />
            ) : entries.length === 0 ? (
              <EmptyState message={t("detail.noEntries")} />
            ) : (
              <div style={{ display: "grid", gap: "var(--space-2)" }}>
                {entries.map((entry) => (
                  <div key={entry.sessionId} style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)", borderTop: "1px solid var(--border-light)", paddingTop: "var(--space-2)" }}>
                    {formatDateTime(entry.clockInAt, i18n.language)}
                    {entry.clockInEvidencePath ? (
                      <button
                        type="button"
                        onClick={() => openEvidence(entry.clockInEvidencePath as string, `${t("columns.clockIn")} — ${formatDateTime(entry.clockInAt, i18n.language)}`)}
                        title={t("viewPhoto")}
                        aria-label={t("viewPhoto")}
                        style={{ display: "inline-flex", verticalAlign: "middle", margin: "0 4px", background: "none", border: "none", cursor: "pointer", color: "var(--text-link)", padding: 0 }}
                      >
                        <Camera size={12} />
                      </button>
                    ) : null}
                    — {entry.clockOutAt ? formatTimeOnly(entry.clockOutAt, i18n.language) : t("detail.stillOpen")}
                    {entry.clockOutEvidencePath ? (
                      <button
                        type="button"
                        onClick={() => openEvidence(entry.clockOutEvidencePath as string, `${t("columns.clockOut")} — ${entry.clockOutAt ? formatDateTime(entry.clockOutAt, i18n.language) : ""}`)}
                        title={t("viewPhoto")}
                        aria-label={t("viewPhoto")}
                        style={{ display: "inline-flex", verticalAlign: "middle", margin: "0 4px", background: "none", border: "none", cursor: "pointer", color: "var(--text-link)", padding: 0 }}
                      >
                        <Camera size={12} />
                      </button>
                    ) : null}
                    {" "}
                    · {entry.siteName ?? "—"}
                    {entry.projectName ? ` · ${entry.projectName}` : ""} · {formatMinutes(entry.workedMinutes)}
                  </div>
                ))}
              </div>
            )}

            {canReviewDetail ? <Textarea label={t("detail.notesLabel")} name="reviewNotes" value={reviewNotes} onChange={(event) => setReviewNotes(event.target.value)} disabled={actionSubmitting} /> : null}

            {canRequestCorrectionDetail && showCorrectionForm ? (
              <Textarea label={t("detail.correctionReasonLabel")} name="correctionReason" value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} disabled={actionSubmitting} required />
            ) : null}
          </>
        ) : null}
      </Modal>

      <Modal
        isOpen={Boolean(correctionReviewTarget)}
        onClose={() => setCorrectionReviewTarget(null)}
        title={correctionReviewTarget ? `${correctionReviewTarget.userFullName} — ${t("pendingCorrections.reviewTitle")}` : ""}
        footer={
          <>
            <Button variant="ghost" onClick={() => handleReviewCorrection("rejected")} loading={correctionReviewSubmitting === "rejected"}>
              {t("detail.rejectAction")}
            </Button>
            <Button onClick={() => handleReviewCorrection("approved")} loading={correctionReviewSubmitting === "approved"}>
              {t("detail.approveAction")}
            </Button>
          </>
        }
      >
        {correctionReviewTarget ? (
          <>
            <p style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{correctionReviewTarget.reason}</p>
            <Textarea label={t("detail.notesLabel")} name="correctionReviewNotes" value={correctionReviewNotes} onChange={(event) => setCorrectionReviewNotes(event.target.value)} disabled={Boolean(correctionReviewSubmitting)} />
          </>
        ) : null}
      </Modal>

      <Modal isOpen={Boolean(evidenceModalTitle)} onClose={closeEvidence} title={evidenceModalTitle ?? t("viewPhoto")}>
        {evidenceLoading ? (
          <LoadingState size="sm" />
        ) : evidenceError ? (
          <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{evidenceError}</p>
        ) : evidenceUrl ? (
          <img src={evidenceUrl} alt={t("viewPhoto")} style={{ maxWidth: "100%", borderRadius: "var(--radius-md)", display: "block" }} />
        ) : null}
      </Modal>
    </PageShell>
  );
}
