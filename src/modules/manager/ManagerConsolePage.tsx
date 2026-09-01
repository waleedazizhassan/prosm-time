import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";
import ManagerRepository, { type TodayAttendanceRow, type PendingReviewItem } from "../../core/repositories/ManagerRepository";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import Table, { type TableColumn } from "../../components/common/Table";
import StatusBadge from "../../components/common/StatusBadge";
import Button from "../../components/common/Button";
import Modal from "../../components/common/Modal";
import Textarea from "../../components/common/Textarea";

const REVIEW_ACTIONS = ["approved", "rejected", "acknowledged", "clarification_requested"] as const;

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
  const { t } = useTranslation("manager");
  const { hasPermission } = useAuth();

  const [attendance, setAttendance] = useState<TodayAttendanceRow[]>([]);
  const [pendingItems, setPendingItems] = useState<PendingReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [reviewTarget, setReviewTarget] = useState<PendingReviewItem | null>(null);
  const [reviewNotes, setReviewNotes] = useState("");
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [error, setError] = useState("");

  const canManageExceptions = hasPermission("exceptions.manage");

  const load = useCallback(async () => {
    setLoading(true);
    const [attendanceResult, pendingResult] = await Promise.all([ManagerRepository.listTodayAttendance(), ManagerRepository.listPendingReview()]);
    setAttendance(attendanceResult.success ? attendanceResult.data ?? [] : []);
    setPendingItems(pendingResult.success ? pendingResult.data ?? [] : []);
    setLoading(false);
  }, []);

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
      setError(result.message ?? t("reviewError"));
      return;
    }

    setReviewTarget(null);
    setReviewNotes("");
    load();
  };

  const attendanceColumns: TableColumn<TodayAttendanceRow>[] = [
    { key: "name", header: t("attendance.employee"), render: (row) => row.userFullName },
    { key: "site", header: t("attendance.site"), render: (row) => row.siteName },
    { key: "status", header: t("attendance.status"), render: (row) => <StatusBadge status={row.status === "clocked_in" ? "active" : "neutral"}>{t(`attendance.${row.status}`)}</StatusBadge> },
    { key: "presence", header: t("attendance.presence"), render: (row) => (row.hasActivePresence ? <StatusBadge status="active">{t("attendance.presenceActive")}</StatusBadge> : "—") },
    { key: "clockInAt", header: t("attendance.clockInAt"), render: (row) => new Date(row.clockInAt).toLocaleTimeString() },
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
        <Table columns={attendanceColumns} data={attendance} getRowId={(row) => row.sessionId} loading={loading} emptyMessage={t("attendance.empty")} />
      </Card>

      <Card title={t("pending.title")}>
        {error ? <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{error}</p> : null}
        {pendingItems.length === 0 ? (
          <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>{t("pending.empty")}</p>
        ) : (
          pendingItems.map((item) => (
            <div key={`${item.kind}-${item.id}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-3)", padding: "var(--space-3) 0", borderTop: "1px solid var(--border-light)" }}>
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
            </div>
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
    </PageShell>
  );
}
