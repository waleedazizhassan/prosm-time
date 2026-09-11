import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import ManagerRepository, { type TodayAttendanceRow, type SosAlertRow } from "../../core/repositories/ManagerRepository";
import AllowanceRepository, { type AllowanceEntry } from "../../core/repositories/AllowanceRepository";
import OrganizationRepository from "../../core/repositories/OrganizationRepository";
import SiteWorkerRepository, { type SiteWorkerAttendanceRow } from "../../core/repositories/SiteWorkerRepository";
import ReportRepository from "../../core/repositories/ReportRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import { formatDateOnly, formatTimeOnly } from "../../core/utils/formatDate";
import savePdfDocument from "../../core/utils/savePdfDocument";
import { buildAttendanceLogPdf } from "../attendance/attendanceLogPdf";
import { buildAllowancesPdf } from "../allowances/allowancesPdf";
import { buildGenericReportPdf } from "./genericReportPdf";

import { useAuth } from "../../core/context/AuthContext";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";
import { REPORT_TYPE_ICONS } from "./reportTypeIcons";
import styles from "./ReportsPage.module.css";

const ALL_EMPLOYEES = "";
const ALL_SITES = "";

// The 3 original report types keep their own bespoke fetch/PDF
// pipeline (unchanged below - see this file's own header comment on
// why timesheets links out rather than being re-implemented here). The
// 8 added for the 14-point live-audit gap #8 are all "generic tabular"
// reports - same fetch-rows/render-table/export-PDF shape, just
// different columns - so they share one config-driven path instead of
// 8 near-duplicate branches.
type BespokeReportType = "attendance" | "allowances" | "timesheets";
type GenericReportType = "workforce" | "contractor" | "site" | "late" | "missingCheckouts" | "leaveConflicts" | "managerOverrides" | "locationViolations" | "sos";
type ReportType = BespokeReportType | GenericReportType;

// § point 2, 2026-09-11 - "an Employee sees report buttons that don't
// apply to them - don't remove them, just don't show them." Every type
// below requires real management scope server-side (attendance.view +
// managed-site data an Employee simply has none of) - a plain
// Employee/read_only would only ever see an empty/near-empty report.
// Gated the same way DashboardPage.tsx now gates the ClockInOutCard
// widget: Owner, or 'exceptions.manage' holders (Manager/Supervisor).
const MANAGEMENT_SCOPED_TYPES: ReportType[] = [
  "workforce",
  "contractor",
  "site",
  "late",
  "missingCheckouts",
  "leaveConflicts",
  "managerOverrides",
  "locationViolations",
  "sos",
];

interface GenericRow {
  cells: string[];
  employeeName: string | null;
  siteName: string | null;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export default function ReportsPage() {
  const { t, i18n } = useTranslation("reports");
  const { t: tAttendance } = useTranslation("attendanceLog");
  const { t: tAllowances } = useTranslation("allowances");
  const { profile, hasPermission } = useAuth();

  // § point 2, 2026-09-11 - same authority test as DashboardPage.tsx's
  // ClockInOutCard gate: Owner, or 'exceptions.manage' holders
  // (Manager/Supervisor) get the full report-type list; everyone else
  // (Employee, read_only) only sees the 3 that are actually about
  // their own, self-scoped data.
  const hasManagementScope = Boolean(profile?.isOwner) || hasPermission("exceptions.manage");
  const visibleReportTypes = useMemo<ReportType[]>(
    () =>
      (["attendance", "allowances", "timesheets", "workforce", "contractor", "site", "late", "missingCheckouts", "leaveConflicts", "managerOverrides", "locationViolations", "sos"] as ReportType[]).filter(
        (type) => hasManagementScope || !MANAGEMENT_SCOPED_TYPES.includes(type),
      ),
    [hasManagementScope],
  );

  const [reportType, setReportType] = useState<ReportType>("attendance");

  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const [startDate, setStartDate] = useState(isoDate(monthStart));
  const [endDate, setEndDate] = useState(isoDate(today));
  const [employeeFilter, setEmployeeFilter] = useState(ALL_EMPLOYEES);
  const [siteFilter, setSiteFilter] = useState(ALL_SITES);

  const [attendanceRows, setAttendanceRows] = useState<TodayAttendanceRow[]>([]);
  const [allowanceEntries, setAllowanceEntries] = useState<AllowanceEntry[]>([]);
  const [genericRows, setGenericRows] = useState<GenericRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [organizationLogoUrl, setOrganizationLogoUrl] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    OrganizationRepository.getCurrentOrganization().then((result) => {
      setOrganizationLogoUrl(result.success ? (result.data?.logoUrl ?? null) : null);
    });
  }, []);

  const locale = i18n.language;

  // Each generic report type's real data source and column layout.
  // toRow/employeeOf both work off the SAME already-typed repository
  // row - no re-fetching, no duplicate mapping.
  const genericConfig = useMemo(() => {
    const config: Record<
      GenericReportType,
      {
        columns: string[];
        fetch: () => Promise<{ success: boolean; message: string | null; data: unknown[] | null }>;
        toRow: (row: never) => { cells: string[]; employeeName: string | null; siteName: string | null };
      }
    > = {
      workforce: {
        columns: [t("columns.workforce.name"), t("columns.workforce.email"), t("columns.workforce.role"), t("columns.workforce.sites"), t("columns.workforce.status")],
        fetch: () => ReportRepository.workforce(),
        toRow: (row: import("../../core/repositories/ReportRepository").WorkforceRow) => ({
          cells: [row.fullName, row.email, row.isOwner ? t("columns.workforce.owner") : row.roleName, row.siteNames || "—", row.status],
          employeeName: row.fullName,
          siteName: null,
        }),
      },
      contractor: {
        columns: [t("columns.contractor.name"), t("columns.contractor.number"), t("columns.contractor.site"), t("columns.contractor.clockIn"), t("columns.contractor.clockOut")],
        fetch: () => SiteWorkerRepository.listAttendance(null, startDate, endDate),
        toRow: (row: SiteWorkerAttendanceRow) => ({
          cells: [row.workerName, row.workerNumber, row.siteName, formatTimeOnly(row.clockInAt, locale), row.clockOutAt ? formatTimeOnly(row.clockOutAt, locale) : "—"],
          employeeName: row.workerName,
          siteName: row.siteName,
        }),
      },
      site: {
        columns: [t("columns.site.name"), t("columns.site.employees"), t("columns.site.hours"), t("columns.site.exceptions")],
        fetch: () => ReportRepository.siteSummary(startDate, endDate),
        toRow: (row: import("../../core/repositories/ReportRepository").SiteSummaryRow) => ({
          cells: [row.siteName, String(row.employeeCount), String(row.totalHours), String(row.exceptionCount)],
          employeeName: null,
          siteName: row.siteName,
        }),
      },
      late: {
        columns: [t("columns.late.name"), t("columns.late.site"), t("columns.late.shiftStart"), t("columns.late.clockIn"), t("columns.late.minutesLate")],
        fetch: () => ReportRepository.late(startDate, endDate),
        toRow: (row: import("../../core/repositories/ReportRepository").LateRow) => ({
          cells: [row.userFullName, row.siteName, row.shiftStartTime.slice(0, 5), formatTimeOnly(row.clockInAt, locale), String(row.minutesLate)],
          employeeName: row.userFullName,
          siteName: row.siteName,
        }),
      },
      missingCheckouts: {
        columns: [t("columns.missingCheckouts.name"), t("columns.missingCheckouts.site"), t("columns.missingCheckouts.clockIn"), t("columns.missingCheckouts.hoursOpen"), t("columns.missingCheckouts.status")],
        fetch: () => ReportRepository.missingCheckouts(startDate, endDate),
        toRow: (row: import("../../core/repositories/ReportRepository").MissingCheckoutRow) => ({
          cells: [
            row.userFullName,
            row.siteName,
            `${formatDateOnly(row.clockInAt, locale)} ${formatTimeOnly(row.clockInAt, locale)}`,
            String(row.hoursOpen),
            row.stillOpen ? t("columns.missingCheckouts.stillOpen") : t("columns.missingCheckouts.eventuallyClosed"),
          ],
          employeeName: row.userFullName,
          siteName: row.siteName,
        }),
      },
      leaveConflicts: {
        columns: [t("columns.leaveConflicts.name"), t("columns.leaveConflicts.site"), t("columns.leaveConflicts.clockIn"), t("columns.leaveConflicts.leaveType"), t("columns.leaveConflicts.leaveRange")],
        fetch: () => ReportRepository.leaveConflicts(startDate, endDate),
        toRow: (row: import("../../core/repositories/ReportRepository").LeaveConflictRow) => ({
          cells: [
            row.userFullName,
            row.siteName,
            `${formatDateOnly(row.clockInAt, locale)} ${formatTimeOnly(row.clockInAt, locale)}`,
            row.leaveType,
            `${formatDateOnly(row.leaveStartDate, locale)} — ${formatDateOnly(row.leaveEndDate, locale)}`,
          ],
          employeeName: row.userFullName,
          siteName: row.siteName,
        }),
      },
      managerOverrides: {
        columns: [t("columns.managerOverrides.actor"), t("columns.managerOverrides.subject"), t("columns.managerOverrides.action"), t("columns.managerOverrides.reason"), t("columns.managerOverrides.when")],
        fetch: () => ReportRepository.managerOverrides(startDate, endDate),
        toRow: (row: import("../../core/repositories/ReportRepository").ManagerOverrideRow) => ({
          cells: [row.actorName, row.subjectName, row.action, row.reason || "—", `${formatDateOnly(row.createdAt, locale)} ${formatTimeOnly(row.createdAt, locale)}`],
          employeeName: null,
          siteName: null,
        }),
      },
      // § point 1, 2026-09-11 - "add an Emergency report, with site and
      // employee filters." Reuses ManagerRepository.listSosAlerts()
      // as-is (a real, already-live, RLS-scoped read - no new RPC
      // needed). Deliberately NOT site-scoped for a Manager, unlike
      // every other type above - matches this session's own earlier,
      // reviewed decision that SOS/emergency visibility must never be
      // restricted by site, since that could delay a real response.
      sos: {
        columns: [t("columns.sos.name"), t("columns.sos.site"), t("columns.sos.triggeredAt"), t("columns.sos.status")],
        fetch: () => ManagerRepository.listSosAlerts(startDate, endDate),
        toRow: (row: SosAlertRow) => ({
          cells: [
            row.userFullName,
            row.siteName || "—",
            `${formatDateOnly(row.triggeredAt, locale)} ${formatTimeOnly(row.triggeredAt, locale)}`,
            row.status === "resolved" ? t("columns.sos.resolved") : t("columns.sos.active"),
          ],
          employeeName: row.userFullName,
          siteName: row.siteName || null,
        }),
      },
      locationViolations: {
        columns: [t("columns.locationViolations.name"), t("columns.locationViolations.site"), t("columns.locationViolations.speed"), t("columns.locationViolations.distance"), t("columns.locationViolations.when")],
        fetch: () => ReportRepository.locationViolations(startDate, endDate),
        toRow: (row: import("../../core/repositories/ReportRepository").LocationViolationRow) => ({
          cells: [
            row.userFullName,
            row.siteName,
            `${row.impliedSpeedKmh} km/h`,
            `${Math.round(row.distanceMeters)} m`,
            `${formatDateOnly(row.occurredAt, locale)} ${formatTimeOnly(row.occurredAt, locale)}`,
          ],
          employeeName: row.userFullName,
          siteName: row.siteName,
        }),
      },
    };
    return config;
  }, [t, startDate, endDate, locale]);

  const load = useCallback(async () => {
    if (reportType === "timesheets" || !startDate || !endDate) return;
    setLoading(true);
    setLoadError("");

    if (reportType === "attendance") {
      const result = await ManagerRepository.listAttendanceHistory(startDate, endDate);
      if (!result.success) {
        setLoadError(humanizeBackendError(result.message, tAttendance) ?? t("loadError"));
        setAttendanceRows([]);
      } else {
        setAttendanceRows(result.data ?? []);
      }
    } else if (reportType === "allowances") {
      const result = await AllowanceRepository.listEntries(startDate, endDate);
      if (!result.success) {
        setLoadError(humanizeBackendError(result.message, tAllowances) ?? t("loadError"));
        setAllowanceEntries([]);
      } else {
        setAllowanceEntries(result.data ?? []);
      }
    } else {
      const cfg = genericConfig[reportType];
      const result = await cfg.fetch();
      if (!result.success) {
        setLoadError(humanizeBackendError(result.message, t) ?? t("loadError"));
        setGenericRows([]);
      } else {
        setGenericRows((result.data ?? []).map((row) => cfg.toRow(row as never)));
      }
    }
    setLoading(false);
  }, [reportType, startDate, endDate, t, tAttendance, tAllowances, genericConfig]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setEmployeeFilter(ALL_EMPLOYEES);
    setSiteFilter(ALL_SITES);
  }, [reportType]);

  // Defense-in-depth, same reasoning as every other permission gate in
  // this codebase (the button list is already filtered below, but a
  // stale selection - e.g. a role change mid-session - must not leave
  // reportType pointed at a now-hidden type).
  useEffect(() => {
    if (!visibleReportTypes.includes(reportType)) setReportType("attendance");
  }, [visibleReportTypes, reportType]);

  const employeeNames = useMemo(() => {
    let names: string[];
    if (reportType === "attendance") names = attendanceRows.map((row) => row.userFullName);
    else if (reportType === "allowances") names = allowanceEntries.map((entry) => entry.userFullName);
    else names = genericRows.map((row) => row.employeeName).filter((name): name is string => Boolean(name));
    const collator = new Intl.Collator(i18n.language, { sensitivity: "base" });
    return Array.from(new Set(names)).sort(collator.compare);
  }, [reportType, attendanceRows, allowanceEntries, genericRows, i18n.language]);

  const employeeOptions = useMemo(
    () => [{ value: ALL_EMPLOYEES, label: t("filters.allEmployees") }, ...employeeNames.map((name) => ({ value: name, label: name }))],
    [employeeNames, t],
  );

  // § point 1, 2026-09-11 - a site filter, same shape as the employee
  // filter above: only shown when the current report type's rows
  // actually carry site data worth filtering on (most generic types
  // do; attendance/allowances/timesheets/workforce/managerOverrides
  // don't set siteName, so this naturally stays hidden for them).
  const siteNames = useMemo(() => {
    const names = genericRows.map((row) => row.siteName).filter((name): name is string => Boolean(name));
    const collator = new Intl.Collator(i18n.language, { sensitivity: "base" });
    return Array.from(new Set(names)).sort(collator.compare);
  }, [genericRows, i18n.language]);

  const siteOptions = useMemo(
    () => [{ value: ALL_SITES, label: t("filters.allSites") }, ...siteNames.map((name) => ({ value: name, label: name }))],
    [siteNames, t],
  );

  const filteredAttendanceRows = useMemo(
    () => (employeeFilter === ALL_EMPLOYEES ? attendanceRows : attendanceRows.filter((row) => row.userFullName === employeeFilter)),
    [attendanceRows, employeeFilter],
  );
  const filteredAllowanceEntries = useMemo(
    () => (employeeFilter === ALL_EMPLOYEES ? allowanceEntries : allowanceEntries.filter((entry) => entry.userFullName === employeeFilter)),
    [allowanceEntries, employeeFilter],
  );
  const filteredGenericRows = useMemo(
    () =>
      genericRows
        .filter((row) => employeeFilter === ALL_EMPLOYEES || row.employeeName === employeeFilter)
        .filter((row) => siteFilter === ALL_SITES || row.siteName === siteFilter),
    [genericRows, employeeFilter, siteFilter],
  );

  const rowCount = reportType === "attendance" ? filteredAttendanceRows.length : reportType === "allowances" ? filteredAllowanceEntries.length : filteredGenericRows.length;

  const handleExport = async () => {
    setExporting(true);
    try {
      const isRtl = i18n.language === "ar";
      if (reportType === "attendance") {
        const doc = await buildAttendanceLogPdf(filteredAttendanceRows, startDate, endDate, i18n.language, tAttendance, organizationLogoUrl);
        await savePdfDocument(doc, `attendance-record-${startDate}-${endDate}.pdf`);
      } else if (reportType === "allowances") {
        const doc = await buildAllowancesPdf(filteredAllowanceEntries, startDate, endDate, i18n.language, tAllowances, organizationLogoUrl);
        await savePdfDocument(doc, `allowances-${startDate}-${endDate}.pdf`);
      } else if (reportType !== "timesheets") {
        const cfg = genericConfig[reportType];
        const doc = await buildGenericReportPdf(
          t(`types.${reportType}`),
          `${startDate} — ${endDate}`,
          cfg.columns.map((header) => ({ header })),
          filteredGenericRows.map((row) => row.cells),
          t("empty"),
          isRtl,
          organizationLogoUrl,
        );
        await savePdfDocument(doc, `${reportType}-${startDate}-${endDate}.pdf`);
      }
    } finally {
      setExporting(false);
    }
  };

  return (
    <PageShell title={t("title")} subtitle={t("subtitle")}>
      <Card>
        <div className={styles.typeGrid}>
          {visibleReportTypes.map((type) => {
            const Icon = REPORT_TYPE_ICONS[type];
            const isActive = reportType === type;
            return (
              <button
                key={type}
                type="button"
                className={`${styles.typeCard} ${isActive ? styles.typeCardActive : ""}`}
                onClick={() => setReportType(type)}
                aria-pressed={isActive}
              >
                <span className={styles.typeIconWrap}>
                  <Icon size={18} className={styles.typeIcon} />
                </span>
                <span className={styles.typeLabel}>{t(`types.${type}`)}</span>
              </button>
            );
          })}
        </div>

        {reportType === "timesheets" ? (
          <p style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
            {t("timesheetsHint")} <Link to="/timesheets">{t("timesheetsLink")}</Link>
          </p>
        ) : (
          <>
            <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap", alignItems: "flex-end" }}>
              <Input label={t("filters.fromLabel")} name="reportsFrom" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
              <Input label={t("filters.toLabel")} name="reportsTo" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
              {employeeNames.length > 1 ? (
                <Select label={t("filters.employeeLabel")} name="reportsEmployee" value={employeeFilter} onChange={(event) => setEmployeeFilter(event.target.value)} options={employeeOptions} />
              ) : null}
              {siteNames.length > 1 ? (
                <Select label={t("filters.siteLabel")} name="reportsSite" value={siteFilter} onChange={(event) => setSiteFilter(event.target.value)} options={siteOptions} />
              ) : null}
            </div>

            <ErrorText>{loadError}</ErrorText>

            <p style={{ margin: "var(--space-4) 0", fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
              {loading ? t("loadingRows") : t("rowCount", { count: rowCount })}
            </p>

            <Button onClick={handleExport} loading={exporting} disabled={loading || rowCount === 0}>
              {t("exportAction")}
            </Button>
          </>
        )}
      </Card>
    </PageShell>
  );
}
