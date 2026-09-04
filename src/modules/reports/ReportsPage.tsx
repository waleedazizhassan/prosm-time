import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import ManagerRepository, { type TodayAttendanceRow } from "../../core/repositories/ManagerRepository";
import AllowanceRepository, { type AllowanceEntry } from "../../core/repositories/AllowanceRepository";
import OrganizationRepository from "../../core/repositories/OrganizationRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import savePdfDocument from "../../core/utils/savePdfDocument";
import { buildAttendanceLogPdf } from "../attendance/attendanceLogPdf";
import { buildAllowancesPdf } from "../allowances/allowancesPdf";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";

const ALL_EMPLOYEES = "";
type ReportType = "attendance" | "allowances" | "timesheets";

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// PROSM Time - § live UX review, user-directed: "a Reports Center
// where he can pull any PDF he wants." A second, discoverable entry
// point for report generation, not a replacement for the existing
// per-page export buttons (both coexist - the same pattern every
// competitor product researched already uses: contextual export on
// the page you're already looking at, plus a dedicated hub). Reuses
// the exact same data-fetch + PDF-build functions those pages already
// call (buildAttendanceLogPdf/buildAllowancesPdf via savePdfDocument)
// - no new report-generation logic exists here. Timesheets are
// deliberately NOT re-implemented as a third date-range report here -
// a timesheet is a specific, already-generated per-employee/per-period
// object (picked from a list, not queried by date range the way
// attendance/allowances are), and TimesheetsPage.tsx already owns that
// whole generate/approve/export flow correctly - duplicating it here
// would just be a second, inconsistent copy of the same state. This
// report type links there instead.
export default function ReportsPage() {
  const { t, i18n } = useTranslation("reports");
  const { t: tAttendance } = useTranslation("attendanceLog");
  const { t: tAllowances } = useTranslation("allowances");

  const [reportType, setReportType] = useState<ReportType>("attendance");

  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const [startDate, setStartDate] = useState(isoDate(monthStart));
  const [endDate, setEndDate] = useState(isoDate(today));
  const [employeeFilter, setEmployeeFilter] = useState(ALL_EMPLOYEES);

  const [attendanceRows, setAttendanceRows] = useState<TodayAttendanceRow[]>([]);
  const [allowanceEntries, setAllowanceEntries] = useState<AllowanceEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [organizationLogoUrl, setOrganizationLogoUrl] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    OrganizationRepository.getCurrentOrganization().then((result) => {
      setOrganizationLogoUrl(result.success ? (result.data?.logoUrl ?? null) : null);
    });
  }, []);

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
    } else {
      const result = await AllowanceRepository.listEntries(startDate, endDate);
      if (!result.success) {
        setLoadError(humanizeBackendError(result.message, tAllowances) ?? t("loadError"));
        setAllowanceEntries([]);
      } else {
        setAllowanceEntries(result.data ?? []);
      }
    }
    setLoading(false);
  }, [reportType, startDate, endDate, t, tAttendance, tAllowances]);

  useEffect(() => {
    load();
  }, [load]);

  const employeeNames = useMemo(() => {
    const names = reportType === "attendance" ? attendanceRows.map((row) => row.userFullName) : allowanceEntries.map((entry) => entry.userFullName);
    const collator = new Intl.Collator(i18n.language, { sensitivity: "base" });
    return Array.from(new Set(names)).sort(collator.compare);
  }, [reportType, attendanceRows, allowanceEntries, i18n.language]);

  const employeeOptions = useMemo(
    () => [{ value: ALL_EMPLOYEES, label: t("filters.allEmployees") }, ...employeeNames.map((name) => ({ value: name, label: name }))],
    [employeeNames, t],
  );

  const filteredAttendanceRows = useMemo(
    () => (employeeFilter === ALL_EMPLOYEES ? attendanceRows : attendanceRows.filter((row) => row.userFullName === employeeFilter)),
    [attendanceRows, employeeFilter],
  );
  const filteredAllowanceEntries = useMemo(
    () => (employeeFilter === ALL_EMPLOYEES ? allowanceEntries : allowanceEntries.filter((entry) => entry.userFullName === employeeFilter)),
    [allowanceEntries, employeeFilter],
  );

  const rowCount = reportType === "attendance" ? filteredAttendanceRows.length : filteredAllowanceEntries.length;

  const handleExport = async () => {
    setExporting(true);
    try {
      if (reportType === "attendance") {
        const doc = await buildAttendanceLogPdf(filteredAttendanceRows, startDate, endDate, i18n.language, tAttendance, organizationLogoUrl);
        await savePdfDocument(doc, `attendance-record-${startDate}-${endDate}.pdf`);
      } else {
        const doc = await buildAllowancesPdf(filteredAllowanceEntries, startDate, endDate, i18n.language, tAllowances, organizationLogoUrl);
        await savePdfDocument(doc, `allowances-${startDate}-${endDate}.pdf`);
      }
    } finally {
      setExporting(false);
    }
  };

  return (
    <PageShell title={t("title")} subtitle={t("subtitle")}>
      <Card>
        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginBottom: "var(--space-4)" }}>
          {(["attendance", "allowances", "timesheets"] as ReportType[]).map((type) => (
            <Button key={type} variant={reportType === type ? "primary" : "ghost"} onClick={() => setReportType(type)}>
              {t(`types.${type}`)}
            </Button>
          ))}
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
