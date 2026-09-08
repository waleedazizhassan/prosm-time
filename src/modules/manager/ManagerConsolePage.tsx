import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate } from "react-router-dom";
import { Camera } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import ManagerRepository, { type TodayAttendanceRow, type PendingReviewItem } from "../../core/repositories/ManagerRepository";
import EvidenceRepository from "../../core/repositories/EvidenceRepository";
import LeaveRepository, { type PendingLeaveReviewRow } from "../../core/repositories/LeaveRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import Table, { type TableColumn } from "../../components/common/Table";
import StatusBadge from "../../components/common/StatusBadge";
import Button from "../../components/common/Button";
import Modal from "../../components/common/Modal";
import ErrorText from "../../components/common/ErrorText";
import Textarea from "../../components/common/Textarea";
import EmptyState from "../../components/common/EmptyState";
import ListRow from "../../components/common/ListRow";
import { formatTimeOnly, formatDateOnly } from "../../core/utils/formatDate";

const REVIEW_ACTIONS = ["approved", "rejected", "acknowledged", "clarification_requested"] as const;

function formatWorkedHours(clockInAt: string, clockOutAt: string | null): string {
  const endMs = clockOutAt ? new Date(clockOutAt).getTime() : Date.now();
  const totalMinutes = Math.max(0, Math.round((endMs - new Date(clockInAt).getTime()) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

// PROSM Time WP-14/§21 - "Operational dashboard... Exceptions and
// approvals." Deliberately does not duplicate Employees (/people),
// Sites/Projects (/sites), or Administrator & Permission Management
// (/people/:id) - this page surfaces only the net-new pieces (today's
// org-wide attendance, the exception/correction review queue) and
// links out to the rest. Schedules/shifts, timesheets, reports, audit
// log viewer, and notification/escalation settings are not built -
// no WP in this Master File owns "schedules" yet, and timesheets/
// reports/audit-log-UI are explicitly WP-16/WP-17/later scope.
export default function ManagerConsolePage() {
  const { t, i18n } = useTranslation("manager");
  const { hasPermission } = useAuth();

  const [attendance, setAttendance] = useState<TodayAttendanceRow[]>([]);
  const [pendingItems, setPendingItems] = useState<PendingReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [reviewTarget, setReviewTarget] = useState<PendingReviewItem | null>(null);
  const [reviewNotes, setReviewNotes] = useState("");
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [evidenceModalTitle, setEvidenceModalTitle] = useState<string | null>(null);
  const [evidenceUrl, setEvidenceUrl] = useState<string | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState("");

  // § user-directed - real PTO/leave management (20260908200000). A
  // separate review queue rather than folded into pendingItems above -
  // leave requests are a genuinely different domain (their own table,
  // their own approve/reject RPC) from geofence exceptions/correction
  // requests, and review-exception's own kind union would need real
  // rework to absorb a third, unrelated kind for no real benefit.
  const [pendingLeave, setPendingLeave] = useState<PendingLeaveReviewRow[]>([]);
  const [leaveReviewTarget, setLeaveReviewTarget] = useState<PendingLeaveReviewRow | null>(null);
  const [leaveReviewNotes, setLeaveReviewNotes] = useState("");
  const [leaveSubmitting, setLeaveSubmitting] = useState<"approved" | "rejected" | null>(null);
  const [leaveError, setLeaveError] = useState("");

  const canManageExceptions = hasPermission("exceptions.manage");

  const load = useCallback(async () => {
    setLoading(true);
    const [attendanceResult, pendingResult, pendingLeaveResult] = await Promise.all([
      ManagerRepository.listTodayAttendance(),
      ManagerRepository.listPendingReview(),
      canManageExceptions ? LeaveRepository.listPendingReview() : Promise.resolve({ success: true, message: null, data: [] as PendingLeaveReviewRow[] }),
    ]);
    setAttendance(attendanceResult.success ? attendanceResult.data ?? [] : []);
    setPendingItems(pendingResult.success ? pendingResult.data ?? [] : []);
    setPendingLeave(pendingLeaveResult.success ? pendingLeaveResult.data ?? [] : []);
    setLoading(false);
  }, [canManageExceptions]);

  useEffect(() => {
    load();
  }, [load]);

  if (!hasPermission("attendance.view")) {
    return <Navigate to="/dashboard" replace />;
  }

  const handleReview = async (actionType: (typeof REVIEW_ACTIONS)[number]) => {
    if (!reviewTarget) return;
    setSubmitting(actionType);
    setError("");

    const result = await ManagerRepository.reviewItem(reviewTarget.kind, reviewTarget.id, actionType, reviewNotes.trim() || undefined);

    setSubmitting(null);

    if (!result.success) {
      setError(humanizeBackendError(result.message, t) ?? t("reviewError"));
      return;
    }

    setReviewTarget(null);
    setReviewNotes("");
    load();
  };

  const handleLeaveReview = async (action: "approved" | "rejected") => {
    if (!leaveReviewTarget) return;
    setLeaveSubmitting(action);
    setLeaveError("");

    const result = await LeaveRepository.review(leaveReviewTarget.id, action, leaveReviewNotes.trim() || undefined);

    setLeaveSubmitting(null);

    if (!result.success) {
      setLeaveError(humanizeBackendError(result.message, t) ?? t("leave.reviewError"));
      return;
    }

    setLeaveReviewTarget(null);
    setLeaveReviewNotes("");
    load();
  };

  // § live UX review, user-directed - "the photo the employee captures
  // should show next to the clock-in time, and the clock-out photo
  // next to the clock-out time." Storage paths only travel with the
  // row (ManagerRepository); the actual image is downloaded on demand
  // here, matching EvidenceRepository's own authenticated-download
  // pattern (no raw public URL, RLS-respecting, revoked on close).
  const openEvidence = async (storagePath: string, title: string) => {
    setEvidenceModalTitle(title);
    setEvidenceUrl(null);
    setEvidenceError("");
    setEvidenceLoading(true);
    const result = await EvidenceRepository.getEvidenceObjectUrl(storagePath);
    setEvidenceLoading(false);
    if (!result.success || !result.data) {
      setEvidenceError(humanizeBackendError(result.message, t) ?? t("attendance.photoLoadError"));
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

  // § final visual consistency pass, correction (item 12) - "structured
  // employee/day row: Employee | Site/Location | Clock In | Clock Out |
  // Status", one row per employee/session rather than a stacked
  // activity stream. This table already rendered one row per session
  // (Table, not a list) - the real gap was a missing Clock Out column
  // (ManagerRepository now selects clock_out_at too) and no day
  // context; both fixed here using the existing real data only.
  //
  // § live UX review, user-directed - the last column showed
  // "Presence: Active" only while WP-18 presence monitoring was live,
  // "—" for every completed session (i.e. almost every row on a real
  // day). Replaced with worked hours (clockInAt -> clockOutAt, or now
  // if still open) - useful for every row, computed from the same real
  // data already on screen, not a new metric.
  const attendanceColumns: TableColumn<TodayAttendanceRow>[] = [
    { key: "name", header: t("attendance.employee"), render: (row) => row.userFullName },
    { key: "site", header: t("attendance.site"), render: (row) => row.siteName },
    {
      key: "clockInAt",
      header: t("attendance.clockInAt"),
      render: (row) => (
        <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-1)" }}>
          {formatTimeOnly(row.clockInAt, i18n.language)}
          {row.clockInEvidencePath ? (
            <button
              type="button"
              onClick={() => openEvidence(row.clockInEvidencePath as string, `${row.userFullName} — ${t("attendance.clockInAt")}`)}
              title={t("attendance.viewPhoto")}
              aria-label={t("attendance.viewPhoto")}
              style={{ display: "inline-flex", alignItems: "center", background: "none", border: "none", cursor: "pointer", color: "var(--text-link)", padding: 0 }}
            >
              <Camera size={14} />
            </button>
          ) : null}
        </span>
      ),
    },
    {
      key: "clockOutAt",
      header: t("attendance.clockOutAt"),
      render: (row) =>
        row.clockOutAt ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-1)" }}>
            {formatTimeOnly(row.clockOutAt, i18n.language)}
            {row.clockOutEvidencePath ? (
              <button
                type="button"
                onClick={() => openEvidence(row.clockOutEvidencePath as string, `${row.userFullName} — ${t("attendance.clockOutAt")}`)}
                title={t("attendance.viewPhoto")}
                aria-label={t("attendance.viewPhoto")}
                style={{ display: "inline-flex", alignItems: "center", background: "none", border: "none", cursor: "pointer", color: "var(--text-link)", padding: 0 }}
              >
                <Camera size={14} />
              </button>
            ) : null}
          </span>
        ) : (
          "—"
        ),
    },
    { key: "status", header: t("attendance.status"), render: (row) => <StatusBadge status={row.status === "clocked_in" ? "active" : "neutral"}>{t(`attendance.${row.status}`)}</StatusBadge> },
    { key: "workedHours", header: t("attendance.workedHours"), render: (row) => formatWorkedHours(row.clockInAt, row.clockOutAt) },
  ];

  return (
    <PageShell title={t("title")} subtitle={t("subtitle")}>
      <p style={{ fontSize: "var(--font-sm)" }}>
        <Link to="/people" style={{ color: "var(--text-link)" }}>
          {t("linkPeople")}
        </Link>
        {" · "}
        <Link to="/sites" style={{ color: "var(--text-link)" }}>
          {t("linkSites")}
        </Link>
      </p>

      <Card title={t("attendance.title")}>
        <p style={{ margin: "calc(-1 * var(--space-2)) 0 var(--space-3)", fontSize: "var(--font-xs)", fontWeight: "var(--font-weight-semibold)", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
          {formatDateOnly(new Date(), i18n.language)}
        </p>
        <Table columns={attendanceColumns} data={attendance} getRowId={(row) => row.sessionId} loading={loading} emptyMessage={t("attendance.empty")} />
      </Card>

      <Card title={t("pending.title")}>
        <ErrorText>{error}</ErrorText>
        {pendingItems.length === 0 ? (
          <EmptyState message={t("pending.empty")} />
        ) : (
          pendingItems.map((item) => (
            <ListRow key={`${item.kind}-${item.id}`}>
              <div>
                <div style={{ fontSize: "var(--font-sm)", color: "var(--text-primary)", fontWeight: "var(--font-weight-semibold)" }}>
                  {item.userFullName} — {t(`pending.kind.${item.kind}`)}
                </div>
                <div style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{item.summary}</div>
              </div>
              {canManageExceptions ? (
                <Button variant="ghost" size="sm" onClick={() => setReviewTarget(item)}>
                  {t("pending.reviewAction")}
                </Button>
              ) : null}
            </ListRow>
          ))
        )}
      </Card>

      <Modal
        isOpen={Boolean(reviewTarget)}
        onClose={() => setReviewTarget(null)}
        title={reviewTarget ? `${reviewTarget.userFullName} — ${t(`pending.kind.${reviewTarget.kind}`)}` : ""}
        footer={
          <>
            {REVIEW_ACTIONS.map((action) => (
              <Button key={action} variant={action === "approved" ? "primary" : "ghost"} onClick={() => handleReview(action)} loading={submitting === action}>
                {t(`pending.action.${action}`)}
              </Button>
            ))}
          </>
        }
      >
        <Textarea label={t("pending.notesLabel")} name="reviewNotes" value={reviewNotes} onChange={(event) => setReviewNotes(event.target.value)} disabled={Boolean(submitting)} />
      </Modal>

      {canManageExceptions ? (
        <Card title={t("leave.title")}>
          {pendingLeave.length === 0 ? (
            <EmptyState message={t("leave.empty")} />
          ) : (
            pendingLeave.map((item) => (
              <ListRow key={item.id}>
                <div>
                  <div style={{ fontSize: "var(--font-sm)", color: "var(--text-primary)", fontWeight: "var(--font-weight-semibold)" }}>
                    {item.employeeName} — {t(`leave.types.${item.leaveType}`)}
                  </div>
                  <div style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
                    {formatDateOnly(item.startDate, i18n.language)} — {formatDateOnly(item.endDate, i18n.language)} ({item.daysCount} {t("leave.daysSuffix")})
                    {item.reason ? ` · ${item.reason}` : ""}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setLeaveReviewTarget(item);
                    setLeaveReviewNotes("");
                    setLeaveError("");
                  }}
                >
                  {t("pending.reviewAction")}
                </Button>
              </ListRow>
            ))
          )}
        </Card>
      ) : null}

      <Modal
        isOpen={Boolean(leaveReviewTarget)}
        onClose={() => setLeaveReviewTarget(null)}
        title={leaveReviewTarget ? `${leaveReviewTarget.employeeName} — ${t(`leave.types.${leaveReviewTarget.leaveType}`)}` : ""}
        footer={
          <>
            <Button variant="danger" onClick={() => handleLeaveReview("rejected")} loading={leaveSubmitting === "rejected"}>
              {t("leave.rejectAction")}
            </Button>
            <Button onClick={() => handleLeaveReview("approved")} loading={leaveSubmitting === "approved"}>
              {t("leave.approveAction")}
            </Button>
          </>
        }
      >
        <Textarea label={t("pending.notesLabel")} name="leaveReviewNotes" value={leaveReviewNotes} onChange={(event) => setLeaveReviewNotes(event.target.value)} disabled={Boolean(leaveSubmitting)} />
        <ErrorText>{leaveError}</ErrorText>
      </Modal>

      <Modal isOpen={Boolean(evidenceModalTitle)} onClose={closeEvidence} title={evidenceModalTitle ?? t("attendance.photoModalTitle")}>
        {evidenceLoading ? (
          <p style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{t("attendance.photoLoading")}</p>
        ) : evidenceError ? (
          <ErrorText>{evidenceError}</ErrorText>
        ) : evidenceUrl ? (
          <img src={evidenceUrl} alt={t("attendance.photoAlt")} style={{ maxWidth: "100%", borderRadius: "var(--radius-md)", display: "block" }} />
        ) : null}
      </Modal>
    </PageShell>
  );
}
