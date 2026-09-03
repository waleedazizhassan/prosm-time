import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { MapPin, UserCheck, Users, ClipboardList } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import SiteRepository, { type Site } from "../../core/repositories/SiteRepository";
import ManagerRepository, { type TodayAttendanceRow, type PendingReviewItem } from "../../core/repositories/ManagerRepository";
import EmployeeRepository, { type OrgMember } from "../../core/repositories/EmployeeRepository";
import Card from "../../components/common/Card";
import Modal from "../../components/common/Modal";
import Table, { type TableColumn } from "../../components/common/Table";
import StatusBadge from "../../components/common/StatusBadge";
import EmptyState from "../../components/common/EmptyState";
import { formatDateOnly, formatTimeOnly } from "../../core/utils/formatDate";
import styles from "./AdminOverviewCard.module.css";

type Drilldown = "sites" | "present" | "employees" | "pending" | null;

interface Kpi {
  key: Exclude<Drilldown, null>;
  icon: typeof MapPin;
  value: number;
  label: string;
}

// PROSM Time - § live UX review, user-directed: "my Dashboard looks
// like the employees' [Dashboard]... a KPI panel for sites, or
// anything professional." An Owner/Admin's Dashboard should read as
// visibly in-control, not identical to an individual contributor's -
// but per the same review's own constraint (no invented capabilities,
// no new backend), every number here is a real read from repositories
// that already exist and already power Manager Console/Sites/People -
// this is a compact rollup of that same real data, not a new domain
// concept. Gated on the same `attendance.view` permission Manager
// Console itself requires, so it only ever appears for someone who
// can already see this data on that page. All reads are RLS-scoped to
// the caller's own managed sites for a non-owner (20260902090000) -
// the title switches to "my sites" rather than "organization" for
// anyone but the Owner, so the label never overclaims what the
// numbers actually cover.
//
// § live UX review, user-directed - "the KPI cards should be
// clickable and show their info": Sites -> names only; Currently
// present -> a plain read-only table (name/time/date/site, no edit
// actions); Registered employees (new tile, every member regardless
// of today's attendance) -> job/site/status at the moment of the
// click; Pending reviews -> the same items Manager Console's own
// queue shows. Every drill-down is a read-only Modal over data this
// component already loaded (or, for Registered employees, one small
// additional read) - never a new capability, just a closer look at
// what the tile already summarizes.
export default function AdminOverviewCard() {
  const { t, i18n } = useTranslation("dashboard");
  const { hasPermission, profile } = useAuth();
  const canView = hasPermission("attendance.view");

  const [loading, setLoading] = useState(true);
  const [sites, setSites] = useState<Site[]>([]);
  const [todayAttendance, setTodayAttendance] = useState<TodayAttendanceRow[]>([]);
  const [pending, setPending] = useState<PendingReviewItem[]>([]);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [siteNamesByUser, setSiteNamesByUser] = useState<Record<string, string[]>>({});

  const [drilldown, setDrilldown] = useState<Drilldown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [sitesResult, attendanceResult, pendingResult, membersResult, assignmentsResult] = await Promise.all([
      SiteRepository.listSites(),
      ManagerRepository.listTodayAttendance(),
      ManagerRepository.listPendingReview(),
      EmployeeRepository.listOrganizationMembers(),
      SiteRepository.listAllAssignedSiteNames(),
    ]);
    setSites(sitesResult.success ? (sitesResult.data ?? []) : []);
    setTodayAttendance(attendanceResult.success ? (attendanceResult.data ?? []) : []);
    setPending(pendingResult.success ? (pendingResult.data ?? []) : []);
    setMembers(membersResult.success ? (membersResult.data ?? []) : []);
    setSiteNamesByUser(assignmentsResult.success ? (assignmentsResult.data ?? {}) : {});
    setLoading(false);
  }, []);

  useEffect(() => {
    if (canView) load();
  }, [canView, load]);

  const presentRows = useMemo(() => todayAttendance.filter((row) => row.status === "clocked_in"), [todayAttendance]);
  const presentUserIds = useMemo(() => new Set(presentRows.map((row) => row.userId)), [presentRows]);

  if (!canView || loading) return null;

  const kpis: Kpi[] = [
    { key: "sites", icon: MapPin, value: sites.length, label: t("overview.sites") },
    { key: "present", icon: UserCheck, value: presentRows.length, label: t("overview.clockedInNow") },
    { key: "employees", icon: Users, value: members.length, label: t("overview.registeredEmployees") },
    { key: "pending", icon: ClipboardList, value: pending.length, label: t("overview.pendingReviews") },
  ];

  const presentColumns: TableColumn<TodayAttendanceRow>[] = [
    { key: "name", header: t("overview.drilldown.nameColumn"), render: (row) => row.userFullName },
    { key: "date", header: t("overview.drilldown.dateColumn"), render: (row) => formatDateOnly(row.clockInAt, i18n.language) },
    { key: "time", header: t("overview.drilldown.timeColumn"), render: (row) => formatTimeOnly(row.clockInAt, i18n.language) },
    { key: "site", header: t("overview.drilldown.siteColumn"), render: (row) => row.siteName || "—" },
  ];

  const employeeColumns: TableColumn<OrgMember>[] = [
    { key: "name", header: t("overview.drilldown.nameColumn"), render: (member) => member.fullName },
    { key: "role", header: t("overview.drilldown.jobColumn"), render: (member) => member.roleName || "—" },
    { key: "site", header: t("overview.drilldown.siteColumn"), render: (member) => (siteNamesByUser[member.id]?.length ? siteNamesByUser[member.id].join(", ") : "—") },
    {
      key: "status",
      header: t("overview.drilldown.statusColumn"),
      render: (member) => (
        <StatusBadge status={presentUserIds.has(member.id) ? "active" : "neutral"}>
          {presentUserIds.has(member.id) ? t("overview.drilldown.activeNow") : t("overview.drilldown.inactiveNow")}
        </StatusBadge>
      ),
    },
  ];

  const drilldownTitle = drilldown ? t(`overview.drilldown.title.${drilldown}`) : "";

  return (
    <Card>
      <div className={styles.header}>
        <span className={styles.eyebrow}>{t(profile?.isOwner ? "overview.title" : "overview.titleScoped")}</span>
        <Link to="/manager" className={styles.link}>
          {t("overview.openManagerAction")}
        </Link>
      </div>
      <div className={styles.grid}>
        {kpis.map((kpi) => (
          <button key={kpi.key} type="button" className={styles.tile} onClick={() => setDrilldown(kpi.key)}>
            <span className={styles.tileIconWrap}>
              <kpi.icon size={26} className={styles.tileIcon} />
            </span>
            <span className={styles.tileContent}>
              <span className={styles.tileValue}>{kpi.value}</span>
              <span className={styles.tileLabel}>{kpi.label}</span>
            </span>
          </button>
        ))}
      </div>

      <Modal isOpen={drilldown !== null} onClose={() => setDrilldown(null)} title={drilldownTitle}>
        {drilldown === "sites" ? (
          sites.length === 0 ? (
            <EmptyState message={t("overview.drilldown.emptySites")} />
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
              {sites.map((site) => (
                <li key={site.id} style={{ padding: "var(--space-2) 0", borderBottom: "1px solid var(--border-light)", fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>
                  {site.name}
                </li>
              ))}
            </ul>
          )
        ) : null}

        {drilldown === "present" ? (
          <Table columns={presentColumns} data={presentRows} getRowId={(row) => row.sessionId} loading={false} emptyMessage={t("overview.drilldown.emptyPresent")} />
        ) : null}

        {drilldown === "employees" ? (
          <Table columns={employeeColumns} data={members} getRowId={(member) => member.id} loading={false} emptyMessage={t("overview.drilldown.emptyEmployees")} />
        ) : null}

        {drilldown === "pending" ? (
          pending.length === 0 ? (
            <EmptyState message={t("overview.drilldown.emptyPending")} />
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
              {pending.map((item) => (
                <li key={`${item.kind}-${item.id}`} style={{ padding: "var(--space-2) 0", borderBottom: "1px solid var(--border-light)" }}>
                  <div style={{ fontSize: "var(--font-sm)", fontWeight: "var(--font-weight-semibold)", color: "var(--text-primary)" }}>
                    {item.userFullName} — {t(`overview.drilldown.pendingKind.${item.kind}`)}
                  </div>
                  <div style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{item.summary}</div>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </Modal>
    </Card>
  );
}
