import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";
import ManagerRepository, { type PendingReviewItem, type PendingReviewKind } from "../../core/repositories/ManagerRepository";
import LeaveRepository, { type PendingLeaveReviewRow, type ApprovedLeaveRow } from "../../core/repositories/LeaveRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import Modal from "../../components/common/Modal";
import ErrorText from "../../components/common/ErrorText";
import Textarea from "../../components/common/Textarea";
import EmptyState from "../../components/common/EmptyState";
import ListRow from "../../components/common/ListRow";
import { formatTimeOnly, formatDateOnly } from "../../core/utils/formatDate";
import managerConsoleHeaderImage from "../../assets/illustrations/manager.svg";
import PageBanner from "../../components/common/PageBanner";
import HintText from "../../components/common/HintText";
import PendingHoursCard from "./PendingHoursCard";

type ReviewAction = "approved" | "rejected" | "acknowledged" | "clarification_requested";
// Owner 2026-10-20 ("what is the right action for each reason?"): only the
// decisions that mean something for each kind of item, each with what it does.
const ACTIONS_BY_KIND: Record<PendingReviewKind, ReviewAction[]> = {
  geofence_exception: ["approved", "rejected", "clarification_requested"],
  correction_request: ["approved", "rejected"],
  offline_time: ["approved", "rejected"],
  mock_location: ["approved", "rejected"],
};

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
  const { hasPermission, profile } = useAuth();

  const [pendingItems, setPendingItems] = useState<PendingReviewItem[]>([]);
  const [reviewTarget, setReviewTarget] = useState<PendingReviewItem | null>(null);
  const [reviewNotes, setReviewNotes] = useState("");
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [error, setError] = useState("");

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

  // § live UX review, user-directed - a real gap found during a
  // multi-role QA pass: cancel_prosm_time_leave_request's own error
  // message pointed employees at "ask your manager to revoke an
  // approved one," but review_prosm_time_leave's existing 'rejected'-
  // on-'approved' capability had no listing surface to actually reach
  // it from. This closes that gap - reuses the same review RPC, adds
  // the missing "find an approved request to revoke" screen. A reason
  // is required here (unlike an ordinary reject) since revoking
  // already-approved leave is more disruptive - the employee may have
  // already made plans around it.
  const [approvedLeave, setApprovedLeave] = useState<ApprovedLeaveRow[]>([]);
  const [revokeTarget, setRevokeTarget] = useState<ApprovedLeaveRow | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const [revokeSubmitting, setRevokeSubmitting] = useState(false);
  const [revokeError, setRevokeError] = useState("");

  const canManageExceptions = hasPermission("exceptions.manage");
  // Owner 2026-10-19: approving leave is its own permission (Managers and the Owner).
  const canApproveLeave = hasPermission("leave.approve");

  const load = useCallback(async () => {
    const [pendingResult, pendingLeaveResult, approvedLeaveResult] = await Promise.all([
      ManagerRepository.listPendingReview(profile ?? undefined),
      canApproveLeave ? LeaveRepository.listPendingReview() : Promise.resolve({ success: true, message: null, data: [] as PendingLeaveReviewRow[] }),
      canApproveLeave ? LeaveRepository.listApproved() : Promise.resolve({ success: true, message: null, data: [] as ApprovedLeaveRow[] }),
    ]);
    setPendingItems(pendingResult.success ? pendingResult.data ?? [] : []);
    setPendingLeave(pendingLeaveResult.success ? pendingLeaveResult.data ?? [] : []);
    setApprovedLeave(approvedLeaveResult.success ? approvedLeaveResult.data ?? [] : []);
  }, [canApproveLeave, profile]);

  useEffect(() => {
    load();
  }, [load]);

  if (!hasPermission("attendance.view")) {
    return <Navigate to="/dashboard" replace />;
  }

  // Audit 1.4 - an offline action recorded with the device's time: say what
  // was done, at what device time, and when it reached the server.
  const reviewSummary = (item: PendingReviewItem) =>
    item.offlineTime
      ? t("pending.offlineTime.summary", {
          action: t(`pending.offlineTime.action.${item.offlineTime.action}`),
          deviceTime: `${formatDateOnly(item.offlineTime.deviceTime, i18n.language)} ${formatTimeOnly(item.offlineTime.deviceTime, i18n.language)}`,
          receivedAt: `${formatDateOnly(item.offlineTime.receivedAt, i18n.language)} ${formatTimeOnly(item.offlineTime.receivedAt, i18n.language)}`,
        })
      : item.mockLocation
        ? t("pending.mockLocation.summary", {
            action: t(`pending.offlineTime.action.${item.mockLocation.eventType}`),
            time: `${formatDateOnly(item.mockLocation.occurredAt, i18n.language)} ${formatTimeOnly(item.mockLocation.occurredAt, i18n.language)}`,
          })
        : item.geofence
          ? t("pending.geofence.summary", { distance: item.geofence.distanceMeters.toLocaleString(i18n.language), reason: item.geofence.reason || "—" })
          : item.correction
            ? t("pending.correction.summary", {
                action: t(`pending.offlineTime.action.${item.correction.eventType}`),
                time: `${formatDateOnly(item.correction.correctTime, i18n.language)} ${formatTimeOnly(item.correction.correctTime, i18n.language)}`,
                reason: item.correction.reason,
              })
            : item.summary;

  const handleReview = async (actionType: ReviewAction) => {
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

  const handleRevoke = async () => {
    if (!revokeTarget || !revokeReason.trim()) return;
    setRevokeSubmitting(true);
    setRevokeError("");

    const result = await LeaveRepository.revokeApproved(revokeTarget.id, revokeReason.trim());

    setRevokeSubmitting(false);

    if (!result.success) {
      setRevokeError(humanizeBackendError(result.message, t) ?? t("leave.reviewError"));
      return;
    }

    setRevokeTarget(null);
    setRevokeReason("");
    load();
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

  return (
    <PageShell title="">
      <PageBanner pageId="manager" illustration={managerConsoleHeaderImage} />

      {/* Owner 2026-10-20 (no duplicates): today's attendance is the Attendance
          Record's Today view (and who is in, on the dashboard); this page is
          for what needs a decision. */}
      <p style={{ margin: "0 0 var(--space-3)", fontSize: "var(--font-sm)" }}>
        <Link to="/attendance?period=today" style={{ color: "var(--text-link)" }}>
          {t("attendance.openToday")}
        </Link>
      </p>

      {hasPermission("sessions.review_pending") ? <PendingHoursCard /> : null}

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
                <div style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{reviewSummary(item)}</div>
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
            {(reviewTarget ? ACTIONS_BY_KIND[reviewTarget.kind] : []).map((action) => (
              <Button key={action} variant={action === "approved" ? "primary" : "ghost"} onClick={() => handleReview(action)} loading={submitting === action}>
                {t(`pending.action.${action}`)}
              </Button>
            ))}
          </>
        }
      >
        {reviewTarget ? (
          // § real bug, live-reported - the modal used to render only
          // the notes field, nothing about the actual request. The
          // details (old/new time or exception distance, and the
          // employee's own reason) already existed on reviewTarget.
          // summary - the outer, now-dimmed list row behind the modal
          // showed it, the modal itself never did. A manager had no
          // way to see what they were approving.
          <div style={{ marginBottom: "var(--space-4)", padding: "var(--space-3)", background: "var(--surface-app)", borderRadius: "var(--radius-md)" }}>
            <p style={{ margin: 0, fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>{reviewSummary(reviewTarget)}</p>
            <p style={{ margin: "var(--space-2) 0 0", fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
              {t("pending.submittedAtLabel")}: {formatDateOnly(reviewTarget.createdAt, i18n.language)} {formatTimeOnly(reviewTarget.createdAt, i18n.language)}
            </p>
          </div>
        ) : null}
        {reviewTarget ? (
          <ul style={{ margin: "0 0 var(--space-3)", paddingInlineStart: "var(--space-4)", fontSize: "var(--font-xs)", color: "var(--text-secondary)", lineHeight: 1.7 }}>
            {ACTIONS_BY_KIND[reviewTarget.kind].map((action) => (
              <li key={action}>
                <strong style={{ color: "var(--text-primary)" }}>{t(`pending.action.${action}`)}:</strong> {t(`pending.effect.${reviewTarget.kind}.${action}`)}
              </li>
            ))}
          </ul>
        ) : null}
        <Textarea label={t("pending.notesLabel")} name="reviewNotes" value={reviewNotes} onChange={(event) => setReviewNotes(event.target.value)} disabled={Boolean(submitting)} />
      </Modal>

      {canApproveLeave ? (
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

      {canApproveLeave ? (
        <Card title={t("leave.revokeTitle")}>
          <HintText small>{t("leave.revokeHint")}</HintText>
          {approvedLeave.length === 0 ? (
            <EmptyState message={t("leave.revokeEmpty")} />
          ) : (
            approvedLeave.map((item) => (
              <ListRow key={item.id}>
                <div>
                  <div style={{ fontSize: "var(--font-sm)", color: "var(--text-primary)", fontWeight: "var(--font-weight-semibold)" }}>
                    {item.employeeName} — {t(`leave.types.${item.leaveType}`)}
                  </div>
                  <div style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
                    {formatDateOnly(item.startDate, i18n.language)} — {formatDateOnly(item.endDate, i18n.language)} ({item.daysCount} {t("leave.daysSuffix")})
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setRevokeTarget(item);
                    setRevokeReason("");
                    setRevokeError("");
                  }}
                >
                  {t("leave.revokeAction")}
                </Button>
              </ListRow>
            ))
          )}
        </Card>
      ) : null}

      <Modal
        isOpen={Boolean(revokeTarget)}
        onClose={() => setRevokeTarget(null)}
        title={revokeTarget ? `${revokeTarget.employeeName} — ${t(`leave.types.${revokeTarget.leaveType}`)}` : ""}
        footer={
          <Button variant="danger" onClick={handleRevoke} loading={revokeSubmitting} disabled={!revokeReason.trim()}>
            {t("leave.revokeAction")}
          </Button>
        }
      >
        <Textarea label={t("leave.revokeReasonLabel")} name="revokeReason" value={revokeReason} onChange={(event) => setRevokeReason(event.target.value)} disabled={revokeSubmitting} />
        <ErrorText>{revokeError}</ErrorText>
      </Modal>

    </PageShell>
  );
}
