import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { useAuth } from "../../../core/context/AuthContext";
import DatabaseManager from "../../../core/database/DatabaseManager";
import ManagerRepository from "../../../core/repositories/ManagerRepository";
import LeaveRepository from "../../../core/repositories/LeaveRepository";
import AllowanceRepository, { type AllowanceSheet } from "../../../core/repositories/AllowanceRepository";
import AttendanceControlRepository from "../../../core/repositories/AttendanceControlRepository";
import SessionReviewRepository from "../../../core/repositories/SessionReviewRepository";
import TimesheetRepository from "../../../core/repositories/TimesheetRepository";
import { formatDateOnly } from "../../../core/utils/formatDate";

import Avatar from "../../../components/common/Avatar";
import AllowanceSheetEditModal from "../../allowances/AllowanceSheetEditModal";
import styles from "./ManagerDashboard.module.css";
import EmptyState from "../../../components/common/EmptyState";

type QueueKind = "review" | "leave" | "allowances" | "permissions" | "overtime" | "sessions" | "timesheets" | "integrity";

interface QueueRow {
  id: string;
  userId: string | null;
  name: string;
  avatarUrl?: string | null;
  summary: string;
  date: string;
  sheet?: AllowanceSheet;
}

const TARGET: Record<QueueKind, string> = {
  review: "/manager",
  leave: "/manager",
  allowances: "/allowances",
  permissions: "/manager",
  overtime: "/manager",
  sessions: "/manager",
  timesheets: "/timesheets",
  integrity: "/manager",
};

// v2.3.43 step 17 (item 5): one approvals queue with a tab per kind and its
// count. Each queue is read only with the reader's own permission (the
// server checks it again); an allowance sheet opens for editing in place,
// the rest open where the decision is made. Empty kinds are not shown.
export default function ApprovalsQueue({ refreshKey, onChanged }: { refreshKey: string; onChanged: () => void }) {
  const { t, i18n } = useTranslation("dashboard");
  const navigate = useNavigate();
  const { profile, hasPermission } = useAuth();
  const isOwner = Boolean(profile?.isOwner);
  const can = useCallback((key: string) => isOwner || hasPermission(key), [isOwner, hasPermission]);

  const [queues, setQueues] = useState<Partial<Record<QueueKind, QueueRow[]>>>({});
  const [loaded, setLoaded] = useState(false);
  const [active, setActive] = useState<QueueKind | null>(null);
  const [sheet, setSheet] = useState<AllowanceSheet | null>(null);

  const load = useCallback(async () => {
    const next: Partial<Record<QueueKind, QueueRow[]>> = {};
    const tasks: Promise<void>[] = [];
    if (can("exceptions.manage")) {
      tasks.push(
        ManagerRepository.listPendingReview().then((result) => {
          if (result.success && result.data) next.review = result.data.map((item) => ({ id: `${item.kind}:${item.id}`, userId: item.userId ?? null, name: item.userFullName, summary: t(`pending.kind.${item.kind}`, { ns: "manager" }), date: item.createdAt }));
        }),
      );
    }
    if (can("leave.approve")) {
      tasks.push(
        LeaveRepository.listPendingReview().then((result) => {
          if (result.success && result.data)
            next.leave = result.data.map((row) => ({ id: row.id, userId: row.userId, name: row.employeeName, summary: t("manager.queue.leaveSummary", { days: row.daysCount, from: formatDateOnly(row.startDate, i18n.language) }), date: row.createdAt }));
        }),
      );
    }
    if (can("allowances.approve")) {
      tasks.push(
        AllowanceRepository.listSheets("submitted").then((result) => {
          if (result.success && result.data)
            next.allowances = result.data.map((row) => ({
              id: row.id,
              userId: row.userId,
              name: row.userFullName,
              summary: t("manager.queue.sheetSummary", { from: formatDateOnly(row.periodStart, i18n.language), to: formatDateOnly(row.periodEnd, i18n.language), total: row.total.toLocaleString(i18n.language) }),
              date: row.submittedAt,
              sheet: row,
            }));
        }),
      );
    }
    if (can("attendance.manage_permissions")) {
      tasks.push(
        AttendanceControlRepository.queue().then((result) => {
          if (!result.success || !result.data) return;
          next.permissions = result.data.requests.map((row) => ({ id: row.id, userId: row.userId, name: row.employeeName, avatarUrl: row.avatarUrl, summary: t(`permissions.kind.${row.kind}`, { ns: "manager" }), date: row.createdAt }));
          next.overtime = result.data.overtime.map((row) => ({ id: `${row.userId}:${row.day}`, userId: row.userId, name: row.employeeName, avatarUrl: row.avatarUrl, summary: t("manager.queue.overtimeSummary", { hours: Math.round((row.overtimePendingApprovalMinutes / 60) * 10) / 10 }), date: row.day }));
        }),
      );
    }
    if (can("sessions.review_pending")) {
      tasks.push(
        SessionReviewRepository.listPending().then((result) => {
          if (result.success && result.data) next.sessions = result.data.map((row) => ({ id: row.sessionId, userId: row.userId, name: row.employeeName, avatarUrl: row.avatarUrl, summary: row.siteName ?? t("manager.queue.sessionSummary"), date: row.clockInAt }));
        }),
      );
    }
    if (can("timesheets.approve")) {
      tasks.push(
        TimesheetRepository.listPendingApprovals().then((result) => {
          if (result.success && result.data)
            next.timesheets = result.data.map((row) => ({ id: row.id, userId: row.userId, name: row.userFullName, summary: t("manager.queue.timesheetSummary", { from: formatDateOnly(row.periodStart, i18n.language), to: formatDateOnly(row.periodEnd, i18n.language) }), date: row.periodEnd }));
        }),
      );
    }
    if (can("attendance.review_integrity_flags")) {
      tasks.push(
        Promise.resolve(DatabaseManager.getClient().rpc("list_prosm_time_integrity_flags", { p_status: "pending_review" })).then(({ data, error }) => {
          if (error || !Array.isArray(data)) return;
          next.integrity = (data as { id: string; user_id: string; employee_name: string; kind: string; created_at: string }[]).map((row) => ({ id: row.id, userId: row.user_id, name: row.employee_name, summary: t(`integrity.kind.${row.kind}`, { ns: "manager", defaultValue: row.kind }), date: row.created_at }));
        }),
      );
    }
    await Promise.allSettled(tasks);
    setQueues(next);
    setLoaded(true);
  }, [can, t, i18n.language]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const kinds = useMemo(() => (Object.keys(queues) as QueueKind[]).filter((kind) => (queues[kind]?.length ?? 0) > 0), [queues]);
  const current = active && kinds.includes(active) ? active : kinds[0] ?? null;
  const rows = current ? queues[current] ?? [] : [];
  const total = kinds.reduce((sum, kind) => sum + (queues[kind]?.length ?? 0), 0);

  const open = (row: QueueRow) => {
    if (current === "allowances" && row.sheet) setSheet(row.sheet);
    else if (current) navigate(TARGET[current]);
  };

  return (
    <>
      <div className={styles.widgetHeader}>
        <h2 className={styles.widgetTitle}>{t("manager.queue.title", { count: total })}</h2>
      </div>
      {kinds.length > 1 ? (
        <div className={styles.tabs} role="tablist">
          {kinds.map((kind) => (
            <button key={kind} type="button" role="tab" aria-selected={current === kind} className={styles.chip} style={current === kind ? { borderColor: "var(--brand-primary)", color: "var(--brand-primary)" } : undefined} onClick={() => setActive(kind)}>
              {t(`manager.queue.kinds.${kind}`)} <b>{queues[kind]?.length}</b>
            </button>
          ))}
        </div>
      ) : null}
      <div className={styles.widgetBody} style={{ maxHeight: 360 }}>
        {!loaded ? (
          <div className={styles.skeleton} style={{ height: 160 }} />
        ) : rows.length === 0 ? (
          <EmptyState kind="success" message={t("manager.queue.empty")} />
        ) : (
          <ul className={styles.rowList}>
            {rows.slice(0, 25).map((row) => (
              <li key={row.id}>
                <Avatar name={row.name} url={row.avatarUrl} userId={row.userId} size="sm" />
                <span className={styles.rowMain}>
                  <span className={styles.rowName}>{row.name}</span>
                  <span className={styles.rowMeta}>
                    {current && kinds.length === 1 ? `${t(`manager.queue.kinds.${current}`)} · ` : ""}
                    {row.summary} · {formatDateOnly(row.date, i18n.language)}
                  </span>
                </span>
                <button type="button" className={styles.chip} onClick={() => open(row)}>
                  {current === "allowances" ? t("manager.queue.edit") : t("manager.queue.open")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <AllowanceSheetEditModal
        sheet={sheet}
        onClose={() => setSheet(null)}
        onChanged={() => {
          void load();
          onChanged();
        }}
      />
    </>
  );
}
