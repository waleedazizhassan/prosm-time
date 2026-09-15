import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { MapPin, UserCheck, Users, CalendarDays, Coffee, CheckCircle2, ClipboardCheck, FileClock, CalendarClock } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import SiteRepository, { type Site } from "../../core/repositories/SiteRepository";
import ManagerRepository, { type TodayAttendanceRow, type PendingReviewItem } from "../../core/repositories/ManagerRepository";
import EmployeeRepository, { type OrgMember } from "../../core/repositories/EmployeeRepository";
import AttendanceRepository from "../../core/repositories/AttendanceRepository";
import LeaveRepository from "../../core/repositories/LeaveRepository";
import TimesheetRepository from "../../core/repositories/TimesheetRepository";
import ShiftRepository from "../../core/repositories/ShiftRepository";
import Card from "../../components/common/Card";
import LoadingState from "../../components/common/LoadingState";
import Modal from "../../components/common/Modal";
import Table, { type TableColumn } from "../../components/common/Table";
import StatusBadge from "../../components/common/StatusBadge";
import EmptyState from "../../components/common/EmptyState";
import { formatDateOnly, formatTimeOnly } from "../../core/utils/formatDate";
import greetingIllustration from "../../assets/illustration-dashboard-greeting.png";
import styles from "./AdminOverviewCard.module.css";

type Drilldown = "sites" | "present" | "employees" | "pending" | "leaveToday" | "onBreak" | null;

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
//
// § user-directed follow-up - "only 4 cards, what's missing? e.g.
// leave today - click it, see names and sites": added "On Leave
// Today" (leave_requests' own RLS already scopes this correctly - see
// LeaveRepository.listToday's own comment) and "On Break Now"
// (break_events' own RLS is the exact same attendance.view-scoped
// posture every other tile here already relies on). Deliberately did
// NOT add more than these two - every other plausible candidate (SOS
// today, pending exceptions) either already has its own dedicated
// surface (Emergency Log) or is already folded into "Pending
// reviews" above, so a third tile would only pad the count without
// showing anything genuinely new.
//
// § "the Owner/Manager dashboard doesn't look professional," 2026-09-11
// - research pass into real SaaS admin-dashboard design (Deputy/
// Jibble/Connecteam's own category, plus general 2026 SaaS dashboard
// design writeups) converged on the same real complaint a flat grid of
// 6 identical tiles has: no hierarchy, so nothing tells the viewer
// what actually needs their attention right now vs. what's just a
// reference number. Concrete patterns borrowed, same real data as
// before (no new backend/RPC):
//   - "one primary number, everything else subordinate" + F-pattern
//     (top-left is the highest-value real estate) -> a real hero row:
//     a live presence stat (computed from data already loaded here,
//     the same presentRows/members this component already fetches)
//     with an actual small progress bar, not just a number in a circle.
//   - "disciplined color reserved for state and meaning, not
//     decoration" -> every tile below used the same brand-green circle
//     regardless of what it meant. Now: the presence bar's color
//     reflects real staffing level (good/watch/low), and Pending
//     Reviews gets its own amber "needs attention" card when non-zero
//     instead of sitting flat among six equal tiles - a "next best
//     action" card (a real button straight into Manager Console's own
//     queue) rather than a passive count, per that same research.
//   - Everything else (Sites, Registered Employees, On Leave Today, On
//     Break Now) moves into a visually quieter secondary row - still
//     real, still clickable, still opens the exact same drill-down
//     modals below, just no longer competing for the same visual
//     weight as what actually needs a decision made on it today.
export default function AdminOverviewCard() {
  const { t, i18n } = useTranslation("dashboard");
  const { hasPermission, profile } = useAuth();
  const canView = hasPermission("attendance.view");
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [sites, setSites] = useState<Site[]>([]);
  const [todayAttendance, setTodayAttendance] = useState<TodayAttendanceRow[]>([]);
  const [pending, setPending] = useState<PendingReviewItem[]>([]);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [siteNamesByUser, setSiteNamesByUser] = useState<Record<string, string[]>>({});
  const [leaveToday, setLeaveToday] = useState<{ id: string; userId: string; employeeName: string; leaveType: string; endDate: string }[]>([]);
  const [onBreak, setOnBreak] = useState<{ id: string; userId: string; userFullName: string; startedAt: string }[]>([]);
  // § real reference screenshots the user sent (Jibble), 2026-09-11 -
  // "Tracked Hours" week chart and a live "Who's In/Out" roster.
  // weeklyHistory reuses ManagerRepository.listAttendanceHistory(), an
  // existing RLS-scoped query Attendance Record's own page already
  // calls for a date range - no new RPC, just the same query pointed
  // at the last 7 days and aggregated client-side into hours/day.
  const [weeklyHistory, setWeeklyHistory] = useState<TodayAttendanceRow[]>([]);
  // § real reference screenshots (Deputy), 2026-09-11 - a single
  // unified "Needs Attention" card aggregating every real pending-
  // action type this app already has, instead of one scattered alert
  // per type. Both reused verbatim from existing repositories
  // (LeaveRepository/TimesheetRepository already power the real Leave
  // and Timesheets approval pages) - no new RPC.
  const [pendingLeaveCount, setPendingLeaveCount] = useState(0);
  const [pendingTimesheetCount, setPendingTimesheetCount] = useState(0);
  // § Deputy's real "Actual vs Scheduled hours" comparison, adapted -
  // scheduled hours come from ShiftRepository.listForSite(), the same
  // query the Shift Roster page already uses per site; summed across
  // every site this caller can see (already RLS-scoped per site).
  const [scheduledHours, setScheduledHours] = useState<number | null>(null);

  const [drilldown, setDrilldown] = useState<Drilldown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const today = new Date();
    const weekStart = new Date(today);
    weekStart.setDate(weekStart.getDate() - 6);
    const isoDate = (d: Date) => d.toISOString().slice(0, 10);
    const weekStartIso = isoDate(weekStart);
    const weekEndIso = isoDate(today);

    const [sitesResult, attendanceResult, pendingResult, membersResult, assignmentsResult, leaveTodayResult, onBreakResult, weeklyResult, pendingLeaveResult, pendingTimesheetResult] =
      await Promise.all([
        SiteRepository.listSites(),
        ManagerRepository.listTodayAttendance(),
        ManagerRepository.listPendingReview(),
        EmployeeRepository.listOrganizationMembers(),
        SiteRepository.listAllAssignedSiteNames(),
        LeaveRepository.listToday(),
        AttendanceRepository.listOnBreakNow(),
        ManagerRepository.listAttendanceHistory(weekStartIso, weekEndIso),
        LeaveRepository.listPendingReview(),
        TimesheetRepository.listPendingApprovals(),
      ]);
    const realSites = sitesResult.success ? (sitesResult.data ?? []) : [];
    setSites(realSites);
    setTodayAttendance(attendanceResult.success ? (attendanceResult.data ?? []) : []);
    setPending(pendingResult.success ? (pendingResult.data ?? []) : []);
    setMembers(membersResult.success ? (membersResult.data ?? []) : []);
    setSiteNamesByUser(assignmentsResult.success ? (assignmentsResult.data ?? {}) : {});
    setLeaveToday(leaveTodayResult.success ? (leaveTodayResult.data ?? []) : []);
    setOnBreak(onBreakResult.success ? (onBreakResult.data ?? []) : []);
    setWeeklyHistory(weeklyResult.success ? (weeklyResult.data ?? []) : []);
    setPendingLeaveCount(pendingLeaveResult.success ? (pendingLeaveResult.data ?? []).length : 0);
    setPendingTimesheetCount(pendingTimesheetResult.success ? (pendingTimesheetResult.data ?? []).length : 0);

    // Sequential (needs real site ids first) and bounded to this
    // caller's own real sites - a real org has a handful of sites, not
    // hundreds, so N parallel per-site calls stays cheap.
    if (realSites.length > 0) {
      const shiftResults = await Promise.all(realSites.map((site) => ShiftRepository.listForSite(site.id, weekStartIso, weekEndIso)));
      let totalScheduled = 0;
      for (const result of shiftResults) {
        if (!result.success || !result.data) continue;
        for (const shift of result.data) {
          if (shift.status !== "scheduled") continue;
          const [startH, startM] = shift.startTime.split(":").map(Number);
          const [endH, endM] = shift.endTime.split(":").map(Number);
          let minutes = endH * 60 + endM - (startH * 60 + startM);
          if (shift.crossesMidnight || minutes < 0) minutes += 24 * 60;
          totalScheduled += minutes / 60;
        }
      }
      setScheduledHours(totalScheduled);
    } else {
      setScheduledHours(0);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (canView) load();
  }, [canView, load]);

  const presentRows = useMemo(() => todayAttendance.filter((row) => row.status === "clocked_in"), [todayAttendance]);
  const presentUserIds = useMemo(() => new Set(presentRows.map((row) => row.userId)), [presentRows]);
  const onBreakUserIds = useMemo(() => new Set(onBreak.map((row) => row.userId)), [onBreak]);

  // § real hours-per-day totals for the last 7 days, from the same
  // weeklyHistory read above - clamps an open (still clocked-in)
  // session's duration at "now" rather than leaving it out, so today's
  // own bar isn't understated while someone's still on shift.
  const weeklyBars = useMemo(() => {
    const days: { key: string; label: string; hours: number }[] = [];
    const now = new Date();
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      days.push({ key: d.toISOString().slice(0, 10), label: d.toLocaleDateString(i18n.language, { weekday: "short" }), hours: 0 });
    }
    const byKey = new Map(days.map((d) => [d.key, d]));
    for (const row of weeklyHistory) {
      const key = new Date(row.clockInAt).toISOString().slice(0, 10);
      const bucket = byKey.get(key);
      if (!bucket) continue;
      const end = row.clockOutAt ? new Date(row.clockOutAt) : now;
      const hours = Math.max(0, (end.getTime() - new Date(row.clockInAt).getTime()) / (1000 * 60 * 60));
      bucket.hours += hours;
    }
    return days;
  }, [weeklyHistory, i18n.language]);
  const weeklyMaxHours = Math.max(1, ...weeklyBars.map((d) => d.hours));
  const weeklyTotalHours = weeklyBars.reduce((sum, d) => sum + d.hours, 0);
  const totalNeedsAttention = pending.length + pendingLeaveCount + pendingTimesheetCount;

  // § real fix for the "blank offline Dashboard" complaint (2026-09-15)
  // - same reasoning as ClockInOutCard's own identical fix: `return
  // null` while loading meant every second of a slow/flaky load (this
  // card alone fires 10 parallel reads plus a per-site follow-up) was
  // a totally blank Owner/Manager Dashboard. A visible spinner reads
  // as "working," not "broken."
  if (!canView) return null;
  if (loading) {
    return (
      <Card>
        <LoadingState fullHeight />
      </Card>
    );
  }

  // Real staffing-level read on data already loaded above - no new
  // fetch. Thresholds are a plain, explainable rule of thumb (not a
  // config value pulled from anywhere) - "most of the roster present"
  // reads as healthy, "under half" is the one state worth a warning
  // color rather than the brand-neutral tone every other tile uses.
  const presencePercent = members.length > 0 ? Math.round((presentRows.length / members.length) * 100) : 0;
  const presenceLevel: "good" | "watch" | "low" = members.length === 0 ? "good" : presencePercent >= 70 ? "good" : presencePercent >= 40 ? "watch" : "low";

  const secondaryKpis: Kpi[] = [
    { key: "sites", icon: MapPin, value: sites.length, label: t("overview.sites") },
    { key: "employees", icon: Users, value: members.length, label: t("overview.registeredEmployees") },
    { key: "leaveToday", icon: CalendarDays, value: leaveToday.length, label: t("overview.leaveToday") },
    { key: "onBreak", icon: Coffee, value: onBreak.length, label: t("overview.onBreakNow") },
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
      <div className={styles.greetingBanner}>
        <div className={styles.greetingText}>
          <span className={styles.greetingEyebrow}>{t(profile?.isOwner ? "overview.greetingEyebrowOwner" : "overview.greetingEyebrowManager")}</span>
          <h2 className={styles.greetingTitle}>{t("overview.greetingTitle", { name: profile?.fullName })}</h2>
        </div>
        <img src={greetingIllustration} alt="" className={styles.greetingIllustration} />
      </div>
      <div className={styles.header}>
        <span className={styles.eyebrowGroup}>
          <span className={styles.eyebrow}>{t(profile?.isOwner ? "overview.title" : "overview.titleScoped")}</span>
          <span className={`${styles.scopeBadge} ${profile?.isOwner ? styles.scopeBadgeOwner : styles.scopeBadgeManager}`}>
            {profile?.isOwner ? t("overview.scopeOwner") : t("overview.scopeManager", { count: sites.length })}
          </span>
        </span>
        <Link to="/manager" className={styles.link}>
          {t("overview.openManagerAction")}
        </Link>
      </div>
      <div className={styles.heroRow}>
        <button
          type="button"
          className={`${styles.presenceHero} ${styles[`presence${presenceLevel === "good" ? "Good" : presenceLevel === "watch" ? "Watch" : "Low"}`]}`}
          onClick={() => setDrilldown("present")}
        >
          <span className={styles.presenceIconWrap}>
            <UserCheck size={28} />
          </span>
          <span className={styles.presenceBody}>
            <span className={styles.presenceEyebrow}>{t("overview.presenceTitle")}</span>
            <span className={styles.presenceValueRow}>
              <span className={styles.presenceValue}>{presentRows.length}</span>
              <span className={styles.presenceOf}>{t("overview.presenceOfTotal", { total: members.length })}</span>
            </span>
            <span className={styles.presenceBarTrack}>
              <span className={styles.presenceBarFill} style={{ width: `${presencePercent}%` }} />
            </span>
          </span>
        </button>

        <div className={styles.attentionCard}>
          <span className={styles.cardTitle}>{t("overview.attentionTitle")}</span>
          {totalNeedsAttention === 0 ? (
            <div className={styles.attentionAllClear}>
              <CheckCircle2 size={18} />
              {t("overview.pendingAllClear")}
            </div>
          ) : (
            <ul className={styles.attentionList}>
              <li className={`${styles.attentionRow} ${pendingTimesheetCount > 0 ? styles.attentionRowActive : ""}`}>
                <FileClock size={18} className={styles.attentionIcon} />
                <span className={styles.attentionLabel}>{t("overview.attentionTimesheets")}</span>
                <button type="button" className={`${styles.attentionBadge} ${pendingTimesheetCount > 0 ? styles.attentionBadgeActive : ""}`} onClick={() => navigate("/timesheets")}>
                  {pendingTimesheetCount}
                </button>
              </li>
              <li className={`${styles.attentionRow} ${pendingLeaveCount > 0 ? styles.attentionRowActive : ""}`}>
                <CalendarClock size={18} className={styles.attentionIcon} />
                <span className={styles.attentionLabel}>{t("overview.attentionLeave")}</span>
                {/* § user-directed fix, 2026-09-11 - this used to send a
                    manager to /leave (the self-service "my own leave"
                    page), not the actual review queue - Manager
                    Console's own leave section is the real destination,
                    matching how the Timesheets row below already
                    behaves. */}
                <button type="button" className={`${styles.attentionBadge} ${pendingLeaveCount > 0 ? styles.attentionBadgeActive : ""}`} onClick={() => navigate("/manager")}>
                  {pendingLeaveCount}
                </button>
              </li>
              <li className={`${styles.attentionRow} ${pending.length > 0 ? styles.attentionRowActive : ""}`}>
                <ClipboardCheck size={18} className={styles.attentionIcon} />
                <span className={styles.attentionLabel}>{t("overview.attentionExceptions")}</span>
                <button type="button" className={`${styles.attentionBadge} ${pending.length > 0 ? styles.attentionBadgeActive : ""}`} onClick={() => setDrilldown("pending")}>
                  {pending.length}
                </button>
              </li>
            </ul>
          )}
        </div>
      </div>

      <div className={styles.insightRow}>
        <div className={styles.chartCard}>
          <span className={styles.cardTitle}>{t("overview.weeklyHoursTitle")}</span>
          <span className={styles.chartTotal}>{t("overview.weeklyHoursTotal", { hours: weeklyTotalHours.toFixed(0) })}</span>
          {scheduledHours !== null && scheduledHours > 0 ? (
            <span className={`${styles.chartComparison} ${weeklyTotalHours >= scheduledHours ? styles.chartComparisonGood : styles.chartComparisonWatch}`}>
              {t("overview.weeklyHoursScheduled", { hours: scheduledHours.toFixed(0) })}
            </span>
          ) : null}
          <div className={styles.barChart}>
            {weeklyBars.map((day) => (
              <div key={day.key} className={styles.barColumn}>
                <span className={styles.barValue}>{day.hours >= 1 ? Math.round(day.hours) : ""}</span>
                <span className={styles.barTrack}>
                  <span className={styles.barFill} style={{ height: `${Math.max(3, (day.hours / weeklyMaxHours) * 100)}%` }} />
                </span>
                <span className={styles.barLabel}>{day.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className={styles.rosterCard}>
          <span className={styles.cardTitle}>{t("overview.rosterTitle")}</span>
          <div className={styles.rosterCounts}>
            <span className={styles.rosterCount}>
              <span className={`${styles.rosterDot} ${styles.rosterDotIn}`} />
              {t("overview.rosterIn", { count: presentRows.length - onBreak.length })}
            </span>
            <span className={styles.rosterCount}>
              <span className={`${styles.rosterDot} ${styles.rosterDotBreak}`} />
              {t("overview.rosterBreak", { count: onBreak.length })}
            </span>
            <span className={styles.rosterCount}>
              <span className={`${styles.rosterDot} ${styles.rosterDotOut}`} />
              {t("overview.rosterOut", { count: Math.max(0, members.length - presentRows.length) })}
            </span>
          </div>
          <ul className={styles.rosterList}>
            {presentRows.length === 0 ? (
              <li className={styles.rosterEmpty}>{t("overview.drilldown.emptyPresent")}</li>
            ) : (
              presentRows.slice(0, 6).map((row) => (
                <li key={row.sessionId} className={styles.rosterRow}>
                  <span className={styles.rosterAvatar}>{row.userFullName.trim().charAt(0).toUpperCase()}</span>
                  <span className={styles.rosterInfo}>
                    <span className={styles.rosterName}>{row.userFullName}</span>
                    <span className={styles.rosterMeta}>{row.siteName || t("overview.drilldown.noSite")}</span>
                  </span>
                  <span className={`${styles.rosterStatusDot} ${onBreakUserIds.has(row.userId) ? styles.rosterDotBreak : styles.rosterDotIn}`} />
                  <span className={styles.rosterTime}>{formatTimeOnly(row.clockInAt, i18n.language)}</span>
                </li>
              ))
            )}
          </ul>
          {presentRows.length > 6 ? (
            <button type="button" className={styles.rosterMore} onClick={() => setDrilldown("present")}>
              {t("overview.rosterSeeAll", { count: presentRows.length })}
            </button>
          ) : null}
        </div>
      </div>

      <div className={styles.grid}>
        {secondaryKpis.map((kpi) => (
          <button key={kpi.key} type="button" className={styles.tile} onClick={() => setDrilldown(kpi.key)}>
            <span className={styles.tileIconWrap}>
              <kpi.icon size={20} className={styles.tileIcon} />
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

        {drilldown === "leaveToday" ? (
          leaveToday.length === 0 ? (
            <EmptyState message={t("overview.drilldown.emptyLeaveToday")} />
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
              {leaveToday.map((item) => (
                <li key={item.id} style={{ padding: "var(--space-2) 0", borderBottom: "1px solid var(--border-light)" }}>
                  <div style={{ fontSize: "var(--font-sm)", fontWeight: "var(--font-weight-semibold)", color: "var(--text-primary)" }}>{item.employeeName}</div>
                  <div style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
                    {siteNamesByUser[item.userId]?.length ? siteNamesByUser[item.userId].join(", ") : t("overview.drilldown.noSite")} ·{" "}
                    {t(`overview.drilldown.leaveType.${item.leaveType}`)} · {t("overview.drilldown.leaveReturns", { date: formatDateOnly(item.endDate, i18n.language) })}
                  </div>
                </li>
              ))}
            </ul>
          )
        ) : null}

        {drilldown === "onBreak" ? (
          onBreak.length === 0 ? (
            <EmptyState message={t("overview.drilldown.emptyOnBreak")} />
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
              {onBreak.map((item) => (
                <li key={item.id} style={{ padding: "var(--space-2) 0", borderBottom: "1px solid var(--border-light)" }}>
                  <div style={{ fontSize: "var(--font-sm)", fontWeight: "var(--font-weight-semibold)", color: "var(--text-primary)" }}>{item.userFullName}</div>
                  <div style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t("overview.drilldown.onBreakSince", { time: formatTimeOnly(item.startedAt, i18n.language) })}</div>
                </li>
              ))}
            </ul>
          )
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
