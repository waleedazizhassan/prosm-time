import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "../../../components/common/Button";
import Card from "../../../components/common/Card";
import EmptyState from "../../../components/common/EmptyState";
import LoadingState from "../../../components/common/LoadingState";
import StatusBadge from "../../../components/common/StatusBadge";
import Table, { type TableColumn } from "../../../components/common/Table";
import { formatDateOnly, formatTimeOnly } from "../../../core/utils/formatDate";
import EmployeeProfileRepository, { type ActivityDay, type EmployeeActivity, type HistoryEntry } from "../../../core/repositories/EmployeeProfileRepository";
import { auditLabel } from "../../dashboard/manager/dashboardLogic";
import styles from "./Profile.module.css";

const hm = (minutes: number | null | undefined) => {
  const m = Math.round(Number(minutes ?? 0));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
};

function useActivity(userId: string) {
  const [data, setData] = useState<EmployeeActivity | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    void EmployeeProfileRepository.activity(userId, 30).then((r) => {
      if (!live) return;
      if (r.error) setError(true);
      setData(r.data);
    });
    return () => {
      live = false;
    };
  }, [userId]);
  return { data, error };
}

const ALL = "__all_sites__";

// HR suite feature 3: the last 30 days of attendance, from the same day figures as timesheets and payroll
export function AttendanceTab({ userId }: { userId: string }) {
  const { t, i18n } = useTranslation("people");
  const { data, error } = useActivity(userId);
  const [picked, setPicked] = useState<string | null>(null);
  if (error) return <EmptyState message={t("profile.loadError")} />;
  if (!data) return <LoadingState />;
  // worked days by site; absent days have no site and show under "all sites"
  const bySite = new Map<string, { name: string; days: number; minutes: number }>();
  for (const d of data.attendance) {
    if (d.state !== "worked") continue;
    const name = d.site ?? "";
    const s = bySite.get(name) ?? { name, days: 0, minutes: 0 };
    s.days += 1;
    s.minutes += Number(d.workedMinutes ?? 0);
    bySite.set(name, s);
  }
  const sites = [...bySite.values()].sort((a, b) => b.days - a.days || a.name.localeCompare(b.name));
  const rows = picked === ALL ? data.attendance : data.attendance.filter((d) => d.state === "worked" && (d.site ?? "") === picked);
  const columns: TableColumn<ActivityDay>[] = [
    { key: "day", header: t("profile.attendance.day"), render: (d) => formatDateOnly(d.day, i18n.language) },
    { key: "site", header: t("profile.attendance.site"), render: (d) => d.site ?? "—" },
    { key: "in", header: t("profile.attendance.in"), render: (d) => (d.firstIn ? formatTimeOnly(d.firstIn, i18n.language) : "—") },
    { key: "out", header: t("profile.attendance.out"), render: (d) => (d.lastOut ? formatTimeOnly(d.lastOut, i18n.language) : "—") },
    { key: "worked", header: t("profile.attendance.worked"), render: (d) => (d.state === "worked" ? hm(d.workedMinutes) : "—") },
    { key: "state", header: "", render: (d) => d.state === "absent"
      ? <StatusBadge status="deactivated">{t("profile.attendance.absent")}</StatusBadge>
      : Number(d.lateMinutes) > 0 ? <StatusBadge status="pending">{t("profile.attendance.late", { minutes: Math.round(Number(d.lateMinutes)) })}</StatusBadge> : null },
  ];
  return (
    <div className={styles.panel}>
      <div className={styles.tiles}>
        <div className={styles.tile}><b>{data.totals.worked}</b><span>{t("profile.attendance.daysWorked", { days: data.days })}</span></div>
        <div className={styles.tile}><b>{hm(data.totals.workedMinutes)}</b><span>{t("profile.attendance.hours")}</span></div>
        <div className={styles.tile}><b>{data.totals.late}</b><span>{t("profile.attendance.lateDays")}</span></div>
        <div className={styles.tile}><b>{data.totals.absent}</b><span>{t("profile.attendance.absentDays")}</span></div>
      </div>
      {/* Owner 2026-11-12: a card per day made the page endless on a phone - a short list of sites,
          each opens its own table, and one button for every site */}
      {picked === null ? (
        <Card title={t("profile.tabs.attendance")}>
          {data.attendance.length === 0 ? <EmptyState message={t("profile.attendance.empty")} /> : (
            <div className={styles.siteList}>
              <button type="button" className={`${styles.siteItem} ${styles.siteAll}`} onClick={() => setPicked(ALL)}>
                <span className={styles.siteName}>{t("profile.attendance.allSites")}</span>
                <span className={styles.siteMeta}>{t("profile.attendance.siteDays", { count: data.attendance.length })}</span>
                <span aria-hidden="true" className={styles.siteArrow}>›</span>
              </button>
              {sites.map((s) => (
                <button key={s.name} type="button" className={styles.siteItem} onClick={() => setPicked(s.name)}>
                  <span className={styles.siteName}>{s.name || t("profile.attendance.noSite")}</span>
                  <span className={styles.siteMeta}>{t("profile.attendance.siteDays", { count: s.days })} · {hm(s.minutes)}</span>
                  <span aria-hidden="true" className={styles.siteArrow}>›</span>
                </button>
              ))}
            </div>
          )}
        </Card>
      ) : (
        <Card title={picked === ALL ? t("profile.attendance.allSites") : picked || t("profile.attendance.noSite")}
          actions={<Button variant="ghost" size="sm" onClick={() => setPicked(null)}>{t("profile.attendance.backToSites")}</Button>}>
          <Table grid columns={picked === ALL ? columns : columns.filter((c) => c.key !== "site")} data={rows} getRowId={(d) => d.day} emptyMessage={t("profile.attendance.empty")} />
        </Card>
      )}
    </div>
  );
}

// HR suite feature 3: the year's leave requests
export function LeaveTab({ userId, children }: { userId: string; children?: React.ReactNode }) {
  const { t, i18n } = useTranslation(["people", "leave"]);
  const { data, error } = useActivity(userId);
  if (error) return <EmptyState message={t("profile.loadError")} />;
  if (!data) return <LoadingState />;
  return (
    <div className={styles.panel}>
      {children}
      <Card title={t("profile.tabs.leave")}>
        {data.leave.length === 0 ? <EmptyState message={t("profile.leave.empty")} /> : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-2)" }}>
            {data.leave.map((l) => (
              <li key={l.id} style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "center", justifyContent: "space-between", padding: "var(--space-2) 0", borderBottom: "1px solid var(--border-light)" }}>
                <span>
                  <strong>{t(`leave:types.${l.type}`, { defaultValue: l.type })}</strong>
                  <span style={{ color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}> · {formatDateOnly(l.startDate, i18n.language)} → {formatDateOnly(l.endDate, i18n.language)} · {t("profile.leave.days", { count: Number(l.days) })}</span>
                </span>
                <StatusBadge status={l.status}>{t(`profile.leave.status.${l.status}`, { defaultValue: l.status })}</StatusBadge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// HR suite feature 3: what changed in the person's file, from the action log
export function HistoryTab({ userId }: { userId: string }) {
  const { t, i18n } = useTranslation(["people", "dashboard"]);
  const [rows, setRows] = useState<HistoryEntry[] | null>(null);
  const [more, setMore] = useState(true);
  const [error, setError] = useState(false);
  const load = async (before: string | null) => {
    const r = await EmployeeProfileRepository.history(userId, before);
    if (r.error) {
      setError(true);
      return;
    }
    const next = r.data ?? [];
    setRows((current) => (before ? [...(current ?? []), ...next] : next));
    setMore(next.length === 50);
  };
  useEffect(() => {
    void load(null);
    // the person changes only with the page
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);
  if (error) return <EmptyState message={t("profile.loadError")} />;
  if (!rows) return <LoadingState />;
  return (
    <Card title={t("profile.tabs.history")}>
      {rows.length === 0 ? <EmptyState message={t("profile.history.empty")} /> : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {rows.map((r) => (
            <li key={r.id} style={{ padding: "var(--space-2) 0", borderBottom: "1px solid var(--border-light)", fontSize: "var(--font-sm)" }}>
              <strong>{auditLabel(r.action, (key) => t(`dashboard:${key}`))}</strong>
              <div style={{ color: "var(--text-secondary)" }}>
                {formatDateOnly(r.createdAt, i18n.language)} {formatTimeOnly(r.createdAt, i18n.language)}
                {r.actorName ? ` · ${r.actorName}` : ""}{r.reason ? ` · ${r.reason}` : ""}
              </div>
            </li>
          ))}
        </ul>
      )}
      {more && rows.length > 0 ? (
        <button type="button" onClick={() => void load(rows[rows.length - 1].createdAt)} style={{ marginTop: "var(--space-2)", border: 0, background: "none", color: "var(--text-link)", cursor: "pointer", font: "inherit" }}>
          {t("profile.history.more")}
        </button>
      ) : null}
    </Card>
  );
}
