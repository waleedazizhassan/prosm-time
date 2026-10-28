import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowDown, ArrowUp, CalendarRange, FileDown, GripVertical, Settings2, UserPlus } from "lucide-react";

import { useAuth } from "../../../core/context/AuthContext";
import DashboardRepository, { type DashboardScope, type DashboardSite, type ManagerDashboard as Dashboard } from "../../../core/repositories/DashboardRepository";
import SiteRepository from "../../../core/repositories/SiteRepository";
import { isRtl } from "../../../i18n/direction";
import humanizeBackendError from "../../../core/utils/humanizeBackendError";
import { formatDateOnly, formatTimeOnly } from "../../../core/utils/formatDate";

import Button from "../../../components/common/Button";
import Modal from "../../../components/common/Modal";
import Input from "../../../components/common/Input";
import Toggle from "../../../components/common/Toggle";
import Textarea from "../../../components/common/Textarea";
import ErrorText from "../../../components/common/ErrorText";
import Avatar from "../../../components/common/Avatar";
import PeopleByRole from "../../people/PeopleByRole";
import ApprovalsQueue from "./ApprovalsQueue";
import ExternalWorkersWidget from "./ExternalWorkersWidget";
import SitesMap from "./SitesMap";
import styles from "./ManagerDashboard.module.css";
import { auditLabel, DEFAULT_HIDDEN, DEFAULT_ORDER, iso, mergeOrder, periodRange, trend, type Period, type WidgetId } from "./dashboardLogic";
import EmptyState from "../../../components/common/EmptyState";
import leaveTypeLabel from "../../leave/leaveTypeLabel";
import KpiSheet, { type KpiSheetKind } from "./KpiSheet";
import { buildDashboardPdf } from "./dashboardPdf";
import OrganizationRepository from "../../../core/repositories/OrganizationRepository";
import savePdfDocument, { exportFileName } from "../../../core/utils/savePdfDocument";
import GrantLeaveModal from "../../leave/GrantLeaveModal";
import Dropdown from "../../../components/common/Dropdown";

const LAYOUT_KEY = "prosm_time_dashboard_layout_v1";
const REFRESH_MS = 60000;

const hours = (minutes: number) => Math.round((minutes / 60) * 10) / 10;

// v2.3.43 step 17 (items 5 and 4): the Owner/Manager dashboard - what needs
// a decision first, the sites at the centre. Filters apply to the figures,
// charts and tables, never to "here now" and the map (a live snapshot).
// Refreshes every minute without reloading. Built from the project's own
// components; the reference images guided the layout only.
export default function ManagerDashboard() {
  const { t, i18n } = useTranslation("dashboard");
  const navigate = useNavigate();
  const { profile, hasPermission } = useAuth();
  const isOwner = Boolean(profile?.isOwner);
  const canGrantLeave = isOwner || hasPermission("leave.approve");

  const [scope, setScope] = useState<DashboardScope>(isOwner ? "org" : "mine");
  const [period, setPeriod] = useState<Period>("week");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [siteFilter, setSiteFilter] = useState("");
  const [sites, setSites] = useState<{ id: string; name: string }[]>([]);
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState<WidgetId[]>(DEFAULT_HIDDEN);
  const [order, setOrder] = useState<WidgetId[]>(DEFAULT_ORDER);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [sortKey, setSortKey] = useState<keyof DashboardSite>("name");
  const [sortAsc, setSortAsc] = useState(true);
  const [openExternal, setOpenExternal] = useState<Record<string, boolean>>({});
  const [sosTarget, setSosTarget] = useState<string | null>(null);
  const [sosNotes, setSosNotes] = useState("");
  const [absenceOpen, setAbsenceOpen] = useState(false);
  // owner 2026-10-27: an absence asked for by phone becomes leave
  const [grantFor, setGrantFor] = useState<{ id: string; name: string } | null>(null);
  const [grantDone, setGrantDone] = useState("");
  // owner 2026-10-27: each figure opens the people behind it
  const [sheet, setSheet] = useState<KpiSheetKind | null>(null);
  // owner 2026-10-27: the dashboard to PDF, for the chosen period
  const [exporting, setExporting] = useState(false);
  const exportPdf = async () => {
    if (!data) return;
    setExporting(true);
    try {
      const organization = await OrganizationRepository.getCurrentOrganization();
      const doc = await buildDashboardPdf(data, range.from, range.to, i18n.language, t, time, organization.data?.logoUrl ?? null);
      await savePdfDocument(doc, exportFileName(t("manager.title"), range.from, range.to), "dashboard", range.from, range.to);
    } finally {
      setExporting(false);
    }
  };
  const openPage = (kind: KpiSheetKind | "absent") => {
    setSheet(null);
    setAbsenceOpen(false);
    const attendancePeriod = period === "day" ? "today" : period === "custom" ? "month" : period;
    if (kind === "present") navigate("/attendance?period=today");
    else if (kind === "hours") navigate(`/attendance?period=${attendancePeriod}`);
    else if (kind === "late") navigate("/reports?type=late");
    else if (kind === "overdue") navigate("/reports?type=missingCheckouts");
    else if (kind === "absent") navigate("/reports?type=absences");
    else navigate("/manager");
  };
  const [chartMode, setChartMode] = useState<"week" | "month" | "year">("week");
  const dragRef = useRef<WidgetId | null>(null);

  const range = useMemo(() => periodRange(period, custom), [period, custom]);
  const chartRange = useMemo(() => {
    const now = new Date();
    if (chartMode === "year") return { from: iso(new Date(now.getFullYear(), 0, 1)), to: iso(new Date(now.getFullYear(), 11, 31)) };
    return periodRange(chartMode, custom);
  }, [chartMode, custom]);
  const [chartData, setChartData] = useState<Dashboard | null>(null);

  const load = useCallback(async () => {
    const result = await DashboardRepository.load(range.from, range.to, scope, siteFilter || null);
    setLoading(false);
    if (!result.success || !result.data) {
      setError(humanizeBackendError(result.message, t) ?? t("manager.loadError"));
      return;
    }
    setError("");
    setData(result.data);
  }, [range, scope, siteFilter, t]);

  useEffect(() => {
    setLoading(true);
    void load();
    const interval = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [load]);

  useEffect(() => {
    DashboardRepository.load(chartRange.from, chartRange.to, scope, siteFilter || null).then((result) => setChartData(result.data));
  }, [chartRange, scope, siteFilter]);

  useEffect(() => {
    SiteRepository.listSites().then((result) => setSites((result.data ?? []).map((site) => ({ id: site.id, name: site.name }))));
    // owner 2026-10-28: a layout saved before the action log moved gets its card hidden once (v2)
    const settled = (saved: { hidden?: WidgetId[]; v?: number }) => (saved.v === 2 ? saved.hidden ?? [] : [...new Set([...(saved.hidden ?? []), ...DEFAULT_HIDDEN])]);
    let local: { hidden: WidgetId[]; order: WidgetId[]; v?: number } | null = null;
    try {
      local = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null");
    } catch {
      local = null;
    }
    if (local) {
      setHidden(settled(local));
      setOrder(mergeOrder(local.order ?? []));
    }
    DashboardRepository.loadLayout().then((server) => {
      if (!server) return;
      setHidden(settled(server as { hidden?: WidgetId[]; v?: number }));
      setOrder(mergeOrder(server.order as WidgetId[]));
    });
  }, []);

  const saveLayout = (nextHidden: WidgetId[], nextOrder: WidgetId[]) => {
    setHidden(nextHidden);
    setOrder(nextOrder);
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify({ hidden: nextHidden, order: nextOrder, v: 2 }));
    } catch {
      // private mode: the server copy still applies
    }
    void DashboardRepository.saveLayout({ hidden: nextHidden, order: nextOrder, v: 2 });
  };

  const acknowledgeSos = async () => {
    if (!sosTarget) return;
    const result = await DashboardRepository.acknowledgeSos(sosTarget, sosNotes.trim());
    if (!result.success) {
      setError(humanizeBackendError(result.message, t) ?? t("manager.loadError"));
      return;
    }
    setSosTarget(null);
    setSosNotes("");
    void load();
  };

  const sortedSites = useMemo(() => {
    const list = [...(data?.sites ?? [])];
    list.sort((a, b) => {
      const x = a[sortKey];
      const y = b[sortKey];
      const result = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), i18n.language);
      return sortAsc ? result : -result;
    });
    return list;
  }, [data, sortKey, sortAsc, i18n.language]);

  const sortBy = (key: keyof DashboardSite) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  const time = (value: string) => formatTimeOnly(value, i18n.language);
  const kpi = data?.kpi;
  const priorities = data?.priorities ?? {};
  const priorityChips = [
    { key: "longSessions", to: "/manager" },
    { key: "pendingHours", to: "/manager" },
    { key: "outsideZone", to: "/attendance?period=today" },
    { key: "outsideExceptions", to: "/manager" },
    { key: "leave", to: "/manager" },
    { key: "allowanceSheets", to: "/allowances" },
    { key: "corrections", to: "/manager" },
    { key: "timesheets", to: "/timesheets" },
    { key: "integrity", to: "/manager" },
    { key: "permissions", to: "/manager" },
  ].filter((chip) => (priorities[chip.key] ?? 0) > 0);

  // External workers are counted apart from the employees (never in "here now").
  const externalNow = (data?.sites ?? []).reduce((sum, site) => sum + (site.external?.presentNow ?? 0), 0);
  const externalSites = (data?.sites ?? []).filter((site) => (site.external?.presentNow ?? 0) > 0).length;

  // the site of each logged action, by name (the dashboard's own sites)
  const siteNames = useMemo(() => new Map((data?.sites ?? []).map((site) => [site.id, site.name])), [data]);

  // the figure cards share a row evenly (no 5 + 2 with a gap)
  const kpiCount = 6 + (data?.canViewExternal ? 1 : 0) + (data?.canViewCost && kpi?.estimatedCost !== null ? 1 : 0);
  const overdueCount = data?.overdue?.length ?? 0;
  const canClockOutOthers = isOwner || hasPermission("attendance.clock_out_on_behalf");

  const workedTrend = trend(kpi?.workedMinutes ?? 0, kpi?.previous?.workedMinutes);
  const overtimeTrend = trend(kpi?.overtimeMinutes ?? 0, kpi?.previous?.overtimeMinutes, true);
  const lateTrend = trend(kpi?.lateCount ?? 0, kpi?.previous?.lateCount, true);

  const widgetVisible = (id: WidgetId) => {
    if (hidden.includes(id)) return false;
    if (id === "cost") return Boolean(data?.canViewCost);
    if (id === "audit") return Boolean(data?.canViewAudit);
    if (id === "external") return Boolean(data?.canViewExternal);
    return true;
  };

  const renderWidget = (id: WidgetId) => {
    if (!widgetVisible(id)) return null;
    switch (id) {
      case "map":
        return (
          <section key={id} className={`${styles.widget} ${styles.span7} ${styles.equal}`} style={{ order: order.indexOf(id) }}>
            <div className={styles.widgetHeader}>
              <h2 className={styles.widgetTitle}>{t("manager.map.title")}</h2>
              <span className={styles.rowMeta}>{t("manager.liveNote")}</span>
            </div>
            {data ? <SitesMap sites={data.sites} people={data.presentNow} /> : <div className={styles.skeleton} style={{ flex: 1 }} />}
          </section>
        );
      case "present":
        return (
          <section key={id} className={`${styles.widget} ${styles.span5} ${styles.equal} ${styles.presentWidget}`} style={{ order: order.indexOf(id) }}>
            <div className={styles.widgetHeader}>
              <h2 className={styles.widgetTitle}>{t("manager.present.title", { count: data?.presentNow.length ?? 0 })}</h2>
              <button type="button" className={styles.chip} onClick={() => navigate("/attendance?period=today")}>
                {t("manager.viewAll")}
              </button>
            </div>
            <div className={styles.widgetBody}>
              {!data ? (
                <div className={styles.skeleton} style={{ height: 200 }} />
              ) : data.presentNow.length === 0 ? (
                <EmptyState message={t("manager.present.empty")} />
              ) : (
                <ul className={styles.rowList}>
                  {data.presentNow.map((person) => (
                    <li key={person.userId}>
                      <Avatar name={person.name} url={person.avatarUrl} size="sm" />
                      <span className={styles.rowMain}>
                        <span className={styles.rowName}>{person.name}</span>
                        <span className={styles.rowMeta}>
                          {[person.siteName, t("manager.present.since", { time: time(person.clockInAt) }), person.timezone !== Intl.DateTimeFormat().resolvedOptions().timeZone ? person.timezone : null]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                      <span className={person.status === "in" ? styles.statusOk : person.status === "break" ? styles.statusWarn : styles.statusBad}>{t(`manager.present.status.${person.status}`)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        );
      case "sites":
        return (
          <section key={id} className={`${styles.widget} ${styles.span7}`} style={{ order: order.indexOf(id) }}>
            <div className={styles.widgetHeader}>
              {/* owner 2026-10-28: after choosing a site down here, back to all of them without scrolling up */}
              {siteFilter ? (
                <>
                  <button type="button" className={`${styles.widgetTitle} ${styles.titleButton}`} onClick={() => setSiteFilter("")} title={t("manager.sites.showAll")}>
                    {t("manager.sites.title")}
                  </button>
                  <button type="button" className={`${styles.chip} ${styles.chipActive}`} onClick={() => setSiteFilter("")}>
                    {t("manager.sites.filteredBy", { site: sites.find((site) => site.id === siteFilter)?.name ?? "" })} <span aria-hidden="true">✕</span>
                  </button>
                </>
              ) : (
                <>
                  <h2 className={styles.widgetTitle}>{t("manager.sites.title")}</h2>
                  <span className={styles.rowMeta}>{t("manager.sites.hint")}</span>
                </>
              )}
            </div>
            <div className={styles.widgetBody}>
              {!data ? (
                <div className={styles.skeleton} style={{ height: 160 }} />
              ) : data.sites.length === 0 ? (
                <EmptyState message={t("manager.sites.empty")} />
              ) : (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      {(["name", "present", "late", "absent", "workedMinutes", "overtimeMinutes"] as (keyof DashboardSite)[]).map((key) => (
                        <th key={String(key)} onClick={() => sortBy(key)} aria-sort={sortKey === key ? (sortAsc ? "ascending" : "descending") : "none"}>
                          {t(`manager.sites.columns.${String(key)}`)}
                          {sortKey === key ? (sortAsc ? " ▲" : " ▼") : ""}
                        </th>
                      ))}
                      <th>{t("manager.sites.columns.status")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedSites.map((site) => (
                      <SiteRows
                        key={site.id}
                        site={site}
                        t={t}
                        externalOpen={Boolean(openExternal[site.id])}
                        onToggleExternal={() => setOpenExternal((all) => ({ ...all, [site.id]: !all[site.id] }))}
                        onFilter={() => setSiteFilter((current) => (current === site.id ? "" : site.id))}
                      />
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        );
      case "external":
        return (
          <section key={id} id="dash-external" className={`${styles.widget} ${styles.span12}`} style={{ order: order.indexOf(id) }}>
            {data ? <ExternalWorkersWidget sites={data.sites} refreshKey={data.asOf} /> : <div className={styles.skeleton} style={{ height: 120 }} />}
          </section>
        );
      case "approvals":
        return (
          <section key={id} className={`${styles.widget} ${styles.span5}`} style={{ order: order.indexOf(id) }}>
            <ApprovalsQueue refreshKey={data?.asOf ?? ""} onChanged={() => void load()} />
          </section>
        );
      case "people":
        return (
          <section key={id} className={`${styles.widget} ${styles.span4}`} style={{ order: order.indexOf(id) }}>
            <div className={styles.widgetHeader}>
              <h2 className={styles.widgetTitle}>{t("manager.people.title")}</h2>
            </div>
            <div className={styles.widgetBody} style={{ maxHeight: 520 }}>
              <PeopleByRole compact onOpen={(person) => navigate(`/people/${person.id}`)} />
            </div>
          </section>
        );
      case "chart":
        return (
          <section key={id} className={`${styles.widget} ${styles.span4}`} style={{ order: order.indexOf(id) }}>
            <div className={styles.widgetHeader}>
              <h2 className={styles.widgetTitle}>{t("manager.chart.title")}</h2>
              <div className={styles.segmented}>
                {(["week", "month", "year"] as const).map((mode) => (
                  <button key={mode} type="button" aria-pressed={chartMode === mode} onClick={() => setChartMode(mode)}>
                    {t(`manager.chart.${mode}`)}
                  </button>
                ))}
              </div>
            </div>
            <ScheduleChart data={chartData} mode={chartMode} t={t} language={i18n.language} />
          </section>
        );
      case "cost":
        return (
          <section key={id} className={`${styles.widget} ${styles.span4}`} style={{ order: order.indexOf(id) }}>
            <div className={styles.widgetHeader}>
              <h2 className={styles.widgetTitle}>{t("manager.cost.title")}</h2>
              <span className={styles.rowMeta}>{t("manager.cost.estimated")}</span>
            </div>
            {data?.allowances ? (
              <>
                <dl className={styles.figures}>
                  <div>
                    <dt>{t("manager.cost.allowances")}</dt>
                    <dd>{data.allowances.total.toLocaleString(i18n.language, { maximumFractionDigits: 0 })}</dd>
                  </div>
                  <div>
                    <dt>{t("manager.cost.overtime")}</dt>
                    <dd>
                      {data.allowances.overtimeAmount.toLocaleString(i18n.language, { maximumFractionDigits: 0 })}
                      <small>{t("manager.hoursValue", { hours: hours(data.allowances.overtimeMinutes) })}</small>
                    </dd>
                  </div>
                </dl>
                <TopSitesCost sites={data.sites} t={t} language={i18n.language} />
                <span className={styles.rowMeta}>{t("manager.cost.note")}</span>
              </>
            ) : (
              <div className={styles.skeleton} style={{ height: 160 }} />
            )}
          </section>
        );
      case "audit":
        return (
          <section key={id} className={`${styles.widget} ${styles.span12}`} style={{ order: order.indexOf(id) }}>
            <div className={styles.widgetHeader}>
              <h2 className={styles.widgetTitle}>{t("manager.audit.title")}</h2>
              <button type="button" className={styles.chip} onClick={() => navigate("/audit-log")}>
                {t("manager.viewAll")}
              </button>
            </div>
            <div className={styles.widgetBody}>
              {!data?.audit ? (
                <div className={styles.skeleton} style={{ height: 120 }} />
              ) : data.audit.length === 0 ? (
                <EmptyState message={t("manager.audit.empty")} />
              ) : (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>{t("manager.audit.columns.time")}</th>
                      <th>{t("manager.audit.columns.actor")}</th>
                      <th>{t("manager.audit.columns.action")}</th>
                      <th>{t("manager.audit.columns.subject")}</th>
                      <th>{t("manager.audit.columns.site")}</th>
                      <th>{t("manager.audit.columns.device")}</th>
                      <th>{t("manager.audit.columns.reason")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.audit.map((row) => (
                      <tr key={row.id}>
                        <td>{`${formatDateOnly(row.created_at, i18n.language)} ${time(row.created_at)}`}</td>
                        <td data-label={t("manager.audit.columns.actor")}>{row.actor_name ?? t("manager.audit.system")}</td>
                        <td data-label={t("manager.audit.columns.action")}>{auditLabel(row.action, t)}</td>
                        <td data-label={t("manager.audit.columns.subject")}>{row.subject_name ?? "—"}</td>
                        <td data-label={t("manager.audit.columns.site")}>{(row.site_id && siteNames.get(row.site_id)) ?? "—"}</td>
                        <td data-label={t("manager.audit.columns.device")}>{row.device ?? "—"}</td>
                        <td data-label={t("manager.audit.columns.reason")}>{row.reason ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        );
    }
  };

  return (
    <div className={styles.page}>
      {/* row 0 (owner 2026-10-26: tidy, and not stuck to the top): the title
          with its actions on one line, then one filter bar */}
      <div className={styles.head}>
        <div className={styles.titleBlock}>
          <h1 className={styles.title}>{t("manager.title")}</h1>
          <p className={styles.subtitle}>
            {t("manager.subtitle", { time: data ? time(data.asOf) : "—" })}
            {data?.holidays.length ? (
              <span className={styles.contractor} style={{ marginInlineStart: 8 }}>
                <CalendarRange size={12} /> {t("manager.nextHoliday", { name: data.holidays[0].name, date: formatDateOnly(data.holidays[0].startDate, i18n.language) })}
              </span>
            ) : null}
          </p>
        </div>
        <div className={styles.actions}>
          {hasPermission("attendance.clock_in_on_behalf") ? (
            <Button size="sm" onClick={() => navigate("/admin-clock")}>
              <UserPlus size={14} /> {t("manager.proxyClock")}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={exportPdf} loading={exporting} disabled={!data} aria-label={t("manager.export.action")} title={t("manager.export.action")}>
            <FileDown size={14} /> <span className={styles.actionLabel}>{t("manager.export.action")}</span>
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setCustomizeOpen(true)} aria-label={t("manager.customize")} title={t("manager.customize")}>
            <Settings2 size={14} /> <span className={styles.actionLabel}>{t("manager.customize")}</span>
          </Button>
        </div>
      </div>

      <div className={styles.filters}>
        <div className={styles.segmented} role="group" aria-label={t("manager.scopeLabel")}>
          {((isOwner ? ["org", "mine", "me"] : ["mine", "me"]) as DashboardScope[]).map((value) => (
            <button key={value} type="button" aria-pressed={scope === value} onClick={() => setScope(value)}>
              {t(`manager.scope.${value}`)}
            </button>
          ))}
        </div>
        <div className={styles.segmented} role="group" aria-label={t("manager.periodLabel")}>
          {(["day", "week", "month", "custom"] as Period[]).map((value) => (
            <button key={value} type="button" aria-pressed={period === value} onClick={() => setPeriod(value)}>
              {t(`manager.period.${value}`)}
            </button>
          ))}
        </div>
        <Dropdown
          className={styles.siteSelect}
          ariaLabel={t("manager.siteFilter")}
          value={siteFilter}
          onChange={setSiteFilter}
          options={[{ value: "", label: t("manager.allSites") }, ...sites.map((site) => ({ value: site.id, label: site.name }))]}
        />
      </div>
      {period === "custom" ? (
        <div className={styles.customRange}>
          <Input label={t("manager.from")} name="dashFrom" type="date" value={custom.from} onChange={(event) => setCustom({ ...custom, from: event.target.value })} />
          <Input label={t("manager.to")} name="dashTo" type="date" value={custom.to} onChange={(event) => setCustom({ ...custom, to: event.target.value })} />
        </div>
      ) : null}

      <ErrorText>{error}</ErrorText>

      {/* row 1: SOS (full width) and the priorities with something waiting */}
      {data?.sos.map((alert) => (
        <div key={alert.id} className={styles.sos} role="alert">
          <AlertTriangle size={20} />
          <span>{t("manager.sos.text", { name: alert.name, site: alert.siteName ?? "—", time: time(alert.triggeredAt) })}</span>
          {alert.latitude !== null ? (
            <a className={styles.chip} href={`https://maps.google.com/?q=${alert.latitude},${alert.longitude}`} target="_blank" rel="noreferrer">
              {t("manager.sos.map")}
            </a>
          ) : null}
          {hasPermission("sos.acknowledge") || isOwner ? (
            <Button size="sm" variant="danger" onClick={() => setSosTarget(alert.id)}>
              {t("manager.sos.acknowledge")}
            </Button>
          ) : null}
        </div>
      ))}
      {priorityChips.length > 0 ? (
        <div className={styles.chips}>
          {priorityChips.map((chip) => (
            <button key={chip.key} type="button" className={styles.chip} onClick={() => navigate(chip.to)}>
              {t(`manager.priorities.${chip.key}`)} <b>{priorities[chip.key]}</b>
            </button>
          ))}
        </div>
      ) : null}

      {/* row 2: the figures */}
      {loading && !data ? (
        <div className={styles.kpis}>
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <div key={index} className={styles.skeleton} style={{ height: 110 }} />
          ))}
        </div>
      ) : kpi ? (
        <div className={styles.kpis} style={{ ["--kpi-count" as string]: kpiCount, ["--kpi-half" as string]: Math.ceil(kpiCount / 2) }}>
          <button type="button" className={styles.kpi} onClick={() => setSheet("present")}>
            <span className={styles.kpiLabel}>{t("manager.kpi.present")}</span>
            <span className={styles.kpiValue}>{kpi.presentNow}</span>
            <span className={styles.kpiHint}>{kpi.hasSchedule ? t("manager.kpi.ofExpected", { expected: kpi.expectedToday }) : t("manager.kpi.ofTeam", { team: data?.teamSize ?? 0 })}</span>
            <span className={styles.bar}>
              <span style={{ width: `${Math.min(100, Math.round((kpi.presentNow / Math.max(1, kpi.hasSchedule ? kpi.expectedToday : data?.teamSize ?? 1)) * 100))}%` }} />
            </span>
          </button>
          <button type="button" className={styles.kpi} onClick={() => setSheet("hours")}>
            <span className={styles.kpiLabel}>{t("manager.kpi.hours")}</span>
            <span className={styles.kpiValue}>{hours(kpi.workedMinutes)}</span>
            <span className={styles.kpiHint}>{kpi.scheduledMinutes ? t("manager.kpi.scheduled", { hours: hours(kpi.scheduledMinutes) }) : t("manager.kpi.noSchedule")}</span>
            <Trend value={workedTrend} t={t} />
          </button>
          <button type="button" className={styles.kpi} onClick={() => setSheet("late")}>
            <span className={styles.kpiLabel}>{t("manager.kpi.late")}</span>
            <span className={styles.kpiValue}>{kpi.lateToday}</span>
            <span className={styles.kpiHint}>{t("manager.kpi.lateInPeriod", { count: kpi.lateCount })}</span>
            <Trend value={lateTrend} t={t} />
          </button>
          <button type="button" className={styles.kpi} onClick={() => setAbsenceOpen(true)}>
            <span className={styles.kpiLabel}>{t("manager.kpi.absent")}</span>
            <span className={styles.kpiValue}>{kpi.absentToday}</span>
            <span className={styles.kpiHint}>{t("manager.kpi.onLeave", { count: kpi.onLeaveToday })}</span>
          </button>
          {/* owner 2026-10-27: still clocked in an hour or more after the shift ended */}
          <button type="button" className={`${styles.kpi} ${overdueCount > 0 ? styles.kpiAlert : ""}`} onClick={() => setSheet("overdue")}>
            <span className={styles.kpiLabel}>{t("manager.kpi.overdue")}</span>
            <span className={styles.kpiValue}>{overdueCount}</span>
            <span className={styles.kpiHint}>{t("manager.kpi.overdueHint")}</span>
          </button>
          <button type="button" className={styles.kpi} onClick={() => setSheet("overtime")}>
            <span className={styles.kpiLabel}>{t("manager.kpi.overtime")}</span>
            <span className={styles.kpiValue}>{hours(kpi.overtimeMinutes)}</span>
            <span className={styles.kpiHint}>{kpi.pendingMinutes ? t("manager.kpi.pendingExcluded", { hours: hours(kpi.pendingMinutes) }) : t("manager.hoursUnit")}</span>
            <Trend value={overtimeTrend} t={t} />
          </button>
          {data?.canViewExternal ? (
            <button type="button" className={styles.kpi} onClick={() => document.getElementById("dash-external")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
              <span className={styles.kpiLabel}>{t("manager.kpi.external")}</span>
              <span className={styles.kpiValue}>{externalNow}</span>
              <span className={styles.kpiHint}>{t("manager.kpi.externalSites", { count: externalSites })}</span>
            </button>
          ) : null}
          {data?.canViewCost && kpi.estimatedCost !== null ? (
            <button type="button" className={styles.kpi} onClick={() => navigate("/allowances")}>
              <span className={styles.kpiLabel}>{t("manager.kpi.cost")}</span>
              <span className={styles.kpiValue}>{kpi.estimatedCost.toLocaleString(i18n.language, { maximumFractionDigits: 0 })}</span>
              <span className={styles.kpiHint}>{t("manager.kpi.costNote")}</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {/* rows 3-6: the widgets (order and visibility are the reader's own) */}
      <div className={styles.grid}>{order.map(renderWidget)}</div>

      {/* owner 2026-10-26: the absent-today card opens the day's sheet - absent first, then on leave */}
      <KpiSheet
        kind={sheet}
        data={data}
        time={time}
        onClose={() => setSheet(null)}
        onOpenPage={openPage}
        onClockOut={canClockOutOthers ? (userId) => navigate(`/admin-clock?user=${userId}`) : undefined}
      />
      <GrantLeaveModal
        person={grantFor}
        onClose={() => setGrantFor(null)}
        onGranted={(message) => {
          setGrantFor(null);
          setGrantDone(message);
          void load();
        }}
      />

      <Modal
        isOpen={absenceOpen}
        onClose={() => {
          setAbsenceOpen(false);
          setGrantDone("");
        }}
        title={t("manager.absence.title", { absent: kpi?.absentToday ?? 0, leave: kpi?.onLeaveToday ?? 0 })}
        size="lg"
        footer={
          <Button variant="ghost" onClick={() => openPage("absent")}>
            {t("manager.sheet.open.absent")}
          </Button>
        }
      >
        {grantDone ? <p className={styles.rowMeta} role="status">{grantDone}</p> : null}
        {(data?.absence ?? []).length === 0 ? (
          <EmptyState message={t("manager.absence.none")} />
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t("manager.absence.columns.name")}</th>
                <th>{t("manager.absence.columns.site")}</th>
                <th>{t("manager.absence.columns.status")}</th>
                <th>{t("manager.absence.columns.details")}</th>
                {canGrantLeave ? <th aria-label={t("manager.absence.grantAction")} /> : null}
              </tr>
            </thead>
            <tbody>
              {(data?.absence ?? []).map((row) => (
                <tr key={`${row.state}-${row.userId}`}>
                  <td style={{ fontWeight: 600 }}>
                    <span className={styles.personCell}>
                      <Avatar name={row.name} url={row.avatarUrl} size="sm" />
                      {row.name}
                    </span>
                  </td>
                  <td data-label={t("manager.absence.columns.site")}>{row.siteName ?? "—"}</td>
                  <td data-label={t("manager.absence.columns.status")}>
                    {row.state === "absent" ? <span className={styles.statusBad}>{t("manager.absence.absent")}</span> : <span className={styles.statusWarn}>{t("manager.absence.leave")}</span>}
                  </td>
                  <td data-label={t("manager.absence.columns.details")}>
                    {row.state === "leave"
                      ? `${leaveTypeLabel(t, row.leaveType ?? "other", row.leaveTypeName)} · ${t("manager.absence.until", { date: formatDateOnly(row.leaveEnd ?? "", i18n.language) })}`
                      : row.shiftStart
                        ? t("manager.absence.shiftAt", { time: row.shiftStart })
                        : t("manager.absence.notClockedIn")}
                  </td>
                  {canGrantLeave ? (
                    <td>
                      {row.state === "absent" ? (
                        <Button size="sm" variant="ghost" onClick={() => setGrantFor({ id: row.userId, name: row.name })}>
                          {t("manager.absence.grantAction")}
                        </Button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Modal>

      <Modal isOpen={Boolean(sosTarget)} onClose={() => setSosTarget(null)} title={t("manager.sos.acknowledgeTitle")} footer={<Button variant="danger" onClick={acknowledgeSos}>{t("manager.sos.acknowledge")}</Button>}>
        <Textarea label={t("manager.sos.notes")} name="sosNotes" value={sosNotes} onChange={(event) => setSosNotes(event.target.value)} />
      </Modal>

      <Modal isOpen={customizeOpen} onClose={() => setCustomizeOpen(false)} title={t("manager.customize")}>
        <p className={styles.rowMeta}>{t("manager.customizeHint")}</p>
        {order.map((id) => (
          <div
            key={id}
            className={styles.customizeRow}
            draggable
            onDragStart={() => (dragRef.current = id)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              const from = dragRef.current;
              if (!from || from === id) return;
              const next = order.filter((item) => item !== from);
              next.splice(next.indexOf(id), 0, from);
              saveLayout(hidden, next);
            }}
          >
            <GripVertical size={16} aria-hidden="true" />
            <span style={{ flex: 1, fontSize: "var(--font-sm)" }}>{t(`manager.widgets.${id}`)}</span>
            <Button size="sm" variant="ghost" aria-label={t("manager.moveUp")} onClick={() => {
              const index = order.indexOf(id);
              if (index <= 0) return;
              const next = [...order];
              [next[index - 1], next[index]] = [next[index], next[index - 1]];
              saveLayout(hidden, next);
            }}>
              <ArrowUp size={14} />
            </Button>
            <Button size="sm" variant="ghost" aria-label={t("manager.moveDown")} onClick={() => {
              const index = order.indexOf(id);
              if (index >= order.length - 1) return;
              const next = [...order];
              [next[index + 1], next[index]] = [next[index], next[index + 1]];
              saveLayout(hidden, next);
            }}>
              <ArrowDown size={14} />
            </Button>
            <Toggle checked={!hidden.includes(id)} onChange={(on) => saveLayout(on ? hidden.filter((item) => item !== id) : [...hidden, id], order)} label={t(`manager.widgets.${id}`)} />
          </div>
        ))}
      </Modal>
    </div>
  );
}

type T = ReturnType<typeof useTranslation>["t"];

function Trend({ value, t }: { value: { change: number; good: boolean } | null; t: T }) {
  if (!value) return null;
  return <span className={value.good ? styles.trendUp : styles.trendDown}>{t("manager.kpi.vsPrevious", { change: `${value.change > 0 ? "+" : ""}${value.change}%` })}</span>;
}

function SiteRows({ site, t, externalOpen, onToggleExternal, onFilter }: { site: DashboardSite; t: T; externalOpen: boolean; onToggleExternal: () => void; onFilter: () => void }) {
  return (
    <>
      <tr onClick={onFilter} style={{ cursor: "pointer" }}>
        <td style={{ fontWeight: 600 }}>{site.name}</td>
        <td data-label={t("manager.sites.columns.present")}>{site.expected ? `${site.present} / ${site.expected}` : site.present}</td>
        <td data-label={t("manager.sites.columns.late")}>{site.late}</td>
        <td data-label={t("manager.sites.columns.absent")}>{site.absent}</td>
        <td data-label={t("manager.sites.columns.workedMinutes")}>{hours(site.workedMinutes)}</td>
        <td data-label={t("manager.sites.columns.overtimeMinutes")}>{hours(site.overtimeMinutes)}</td>
        <td data-label={t("manager.sites.columns.status")}>
          {site.sos ? (
            <span className={styles.statusBad}>{t("manager.sites.statusSos")}</span>
          ) : site.outside > 0 ? (
            <span className={styles.statusWarn}>{t("manager.sites.statusOutside", { count: site.outside })}</span>
          ) : (
            <span className={styles.statusOk}>{t("manager.sites.statusOk")}</span>
          )}
        </td>
      </tr>
      {site.external ? (
        <tr className={styles.subRow}>
          <td colSpan={7}>
            <button type="button" className={styles.chip} onClick={onToggleExternal} aria-expanded={externalOpen}>
              {t("manager.sites.external")} · {t("manager.sites.externalSummary", { present: site.external.presentNow, today: site.external.today, hours: hours(site.external.minutesToday) })}
            </button>
            {externalOpen ? (
              site.external.contractors.length === 0 ? (
                <span style={{ marginInlineStart: 8 }}>{t("manager.sites.noExternal")}</span>
              ) : (
                <span style={{ marginInlineStart: 8 }}>
                  {site.external.contractors.map((contractor) => (
                    <span key={contractor.name} className={styles.contractor}>
                      {(contractor.name || t("manager.sites.noContractor")) + ` ${contractor.present}/${contractor.today}`}
                    </span>
                  ))}
                </span>
              )
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

function TopSitesCost({ sites, t, language }: { sites: DashboardSite[]; t: T; language: string }) {
  const top = sites.filter((site) => (site.cost ?? 0) > 0).sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0)).slice(0, 5);
  if (top.length === 0) return <EmptyState message={t("manager.cost.noSites")} />;
  const max = top[0].cost ?? 1;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {top.map((site) => (
        <div key={site.id} style={{ display: "grid", gridTemplateColumns: "7rem 1fr auto", alignItems: "center", gap: 8, fontSize: "0.75rem" }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{site.name}</span>
          <span className={styles.bar}>
            <span style={{ width: `${Math.round(((site.cost ?? 0) / max) * 100)}%` }} />
          </span>
          <span>{(site.cost ?? 0).toLocaleString(language, { maximumFractionDigits: 0 })}</span>
        </div>
      ))}
    </div>
  );
}

function ScheduleChart({ data, mode, t, language }: { data: Dashboard | null; mode: "week" | "month" | "year"; t: T; language: string }) {
  if (!data) return <div className={styles.skeleton} style={{ height: 220 }} />;
  const bars =
    mode === "year"
      ? data.chartMonthly.map((month) => ({ label: new Date(`${month.month}-01`).toLocaleDateString(language, { month: "short" }), worked: month.workedMinutes, scheduled: 0, pending: 0 }))
      : data.chart.map((day) => ({
          label: new Date(day.day).toLocaleDateString(language, mode === "week" ? { weekday: "short" } : { day: "numeric" }),
          worked: day.workedMinutes,
          scheduled: day.scheduledMinutes,
          pending: day.pendingMinutes,
        }));
  if (bars.length === 0 || bars.every((bar) => bar.worked === 0 && bar.scheduled === 0)) return <EmptyState message={t("manager.chart.empty")} />;
  const max = Math.max(...bars.map((bar) => Math.max(bar.worked + bar.pending, bar.scheduled)), 1);
  const width = 100 / bars.length;
  const rtl = isRtl(language);
  return (
    <>
      <svg viewBox="0 0 100 60" preserveAspectRatio="none" className={styles.chart} role="img" aria-label={t("manager.chart.title")}>
        {bars.map((bar, index) => {
          // the labels below follow the page direction; so do the bars (Sunday on the right in Arabic)
          const slot = rtl ? bars.length - 1 - index : index;
          const x = slot * width + width * 0.15;
          const w = width * 0.7;
          const workedH = (bar.worked / max) * 52;
          const pendingH = (bar.pending / max) * 52;
          const scheduledH = (bar.scheduled / max) * 52;
          return (
            <g key={index}>
              {bar.scheduled ? <rect x={x} y={56 - scheduledH} width={w} height={scheduledH} fill="none" stroke="var(--text-tertiary, #94a3b8)" strokeDasharray="1 1" strokeWidth="0.3" /> : null}
              <rect x={x} y={56 - workedH} width={w} height={workedH} fill="var(--brand-primary)" rx="0.6" />
              {bar.pending ? <rect x={x} y={56 - workedH - pendingH} width={w} height={pendingH} fill="var(--status-warning-text, #b45309)" opacity="0.45" /> : null}
              <title>{`${bar.label}: ${hours(bar.worked)}${bar.scheduled ? ` / ${hours(bar.scheduled)}` : ""}`}</title>
            </g>
          );
        })}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "var(--text-secondary)" }}>
        {bars.map((bar, index) => (
          <span key={index} style={{ width: `${width}%`, textAlign: "center", overflow: "hidden" }}>
            {bars.length > 16 && index % 3 ? "" : bar.label}
          </span>
        ))}
      </div>
      <span className={styles.rowMeta}>{t("manager.chart.legend")}</span>
    </>
  );
}
