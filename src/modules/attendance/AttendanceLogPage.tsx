import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Camera, MapPin, Check, X } from "lucide-react";

import ManagerRepository, { type TodayAttendanceRow, type AttendanceEventLocation } from "../../core/repositories/ManagerRepository";
import EvidenceRepository from "../../core/repositories/EvidenceRepository";
import OrganizationRepository from "../../core/repositories/OrganizationRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import savePdfDocument, { exportFileName, printPdfDocument } from "../../core/utils/savePdfDocument";
import ErrorText from "../../components/common/ErrorText";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Table, { type TableColumn } from "../../components/common/Table";
import StatusBadge from "../../components/common/StatusBadge";
import Modal from "../../components/common/Modal";
import Button from "../../components/common/Button";
import attendanceHeaderImage from "../../assets/illustrations/attendance.svg";
import { formatTimeOnly } from "../../core/utils/formatDate";
import { buildAttendanceLogPdf } from "./attendanceLogPdf";
import PageBanner from "../../components/common/PageBanner";
import { PERIODS, formatHours, isPeriod, periodRange, sessionHours, type Period } from "./periods";
import { attendanceNoteLines, startingSiteName } from "./attendanceNotes";
import HintText from "../../components/common/HintText";
import DateRange from "../../components/common/DateRange";
import PersonName from "../../components/common/PersonName";

const ALL_EMPLOYEES = "";

function formatWorkedHours(clockInAt: string, clockOutAt: string | null): string {
  const endMs = clockOutAt ? new Date(clockOutAt).getTime() : Date.now();
  const totalMinutes = Math.max(0, Math.round((endMs - new Date(clockInAt).getTime()) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

// § live UX review, user-directed - "next to the site name, show the
// real GPS location captured, plus whether it matched the site."
// A plain Google Maps link rather than a reverse-geocoded address - no
// geocoding provider exists in this codebase, and coordinates are
// already the real, verifiable source of truth an admin can act on.
function LocationCell({ location, t }: { location: AttendanceEventLocation | null; t: (key: string) => string }) {
  if (!location) return <>—</>;
  const mapsUrl = `https://www.google.com/maps?q=${location.latitude},${location.longitude}`;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-1)" }}>
      <a
        href={mapsUrl}
        target="_blank"
        rel="noreferrer"
        title={t("viewOnMap")}
        style={{ display: "inline-flex", alignItems: "center", gap: "2px", color: "var(--text-link)", textDecoration: "none", fontSize: "var(--font-xs)" }}
      >
        <MapPin size={13} />
        {location.latitude.toFixed(4)}, {location.longitude.toFixed(4)}
      </a>
      {location.withinGeofence === true ? (
        <span title={t("locationMatch")}>
          <Check size={14} color="var(--status-success-text)" aria-label={t("locationMatch")} />
        </span>
      ) : location.withinGeofence === false ? (
        <span title={t("locationMismatch")}>
          <X size={14} color="var(--status-danger-text)" aria-label={t("locationMismatch")} />
        </span>
      ) : null}
    </span>
  );
}

// § live UX review, user-directed - the optional note/activity typed
// into the confirmation screen right before a clock-in/out submits,
// shown to managers here the same "the record itself carries what
// happened" way site changes already are.
// Owner 2026-10-18: one Notes column for everything the employee wrote -
// the clock-in and clock-out notes and activity, and a reason given by
// the former early-leave prompt.
function NotesCell({ row, t, time }: { row: TodayAttendanceRow; t: (key: string, options?: Record<string, unknown>) => string; time: (iso: string) => string }) {
  const lines = attendanceNoteLines(row, t, time);
  if (lines.length === 0) return <>—</>;
  return (
    <>
      {lines.map((line) => (
        <span key={line} style={{ display: "block", fontSize: "var(--font-xs)", color: "var(--text-secondary)", whiteSpace: "pre-wrap" }}>
          {line}
        </span>
      ))}
    </>
  );
}

// PROSM Time - direct sidebar request (live UX review, user-directed):
// "a direct sidebar button to view employees' clock-in/clock-out
// record." Deliberately its own screen rather than folded into
// Manager Console (which stays "today + pending reviews only", its
// own documented scope) or Timesheets (which is period-object
// generation/approval, not a raw log). No permission gate at all -
// attendance_sessions' own RLS already returns exactly what the
// caller is entitled to see (their own sessions always; a Manager's
// own managed sites' people; everyone, for the Owner - 20260902090000)
// so an employee opening this same screen simply sees their own
// history, with zero role branching needed in this component.
// Audit 1.4 - the time came from the employee's device (an offline action
// sent later) and waits for a manager's review.
function DeviceTimeBadge({ label, hint }: { label: string; hint: string }) {
  return (
    <span style={{ display: "block", marginTop: 2 }} title={hint}>
      <StatusBadge status="pending">{label}</StatusBadge>
    </span>
  );
}

export default function AttendanceLogPage() {
  const { t, i18n } = useTranslation("attendanceLog");

  // Owner 2026-10-19: quick day / week (from Sunday) / month views; the
  // employee's home page links here with ?period=today|week|month.
  const [searchParams] = useSearchParams();
  const requestedPeriod = searchParams.get("period");
  const initialRange = periodRange(isPeriod(requestedPeriod) ? requestedPeriod : "month");

  const [startDate, setStartDate] = useState(initialRange.start);
  const [endDate, setEndDate] = useState(initialRange.end);
  const choosePeriod = (period: Period) => {
    const range = periodRange(period);
    setStartDate(range.start);
    setEndDate(range.end);
  };
  const activePeriod = PERIODS.find((period) => {
    const range = periodRange(period);
    return range.start === startDate && range.end === endDate;
  });
  const [rows, setRows] = useState<TodayAttendanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [employeeFilter, setEmployeeFilter] = useState(ALL_EMPLOYEES);

  const [evidenceModalTitle, setEvidenceModalTitle] = useState<string | null>(null);
  const [evidenceUrl, setEvidenceUrl] = useState<string | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState("");

  const [organizationLogoUrl, setOrganizationLogoUrl] = useState<string | null>(null);
  const [exportingPdf, setExportingPdf] = useState(false);

  const load = useCallback(async () => {
    if (!startDate || !endDate) return;
    setLoading(true);
    setLoadError("");
    const result = await ManagerRepository.listAttendanceHistory(startDate, endDate);
    if (!result.success) {
      console.warn("[attendance] could not load the records:", result.message);
      setLoadError(humanizeBackendError(result.message, t) ?? t("loadError"));
      setRows([]);
      setLoading(false);
      return;
    }
    setRows(result.data ?? []);
    setLoading(false);
  }, [startDate, endDate, t]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    OrganizationRepository.getCurrentOrganization().then((result) => {
      setOrganizationLogoUrl(result.success ? (result.data?.logoUrl ?? null) : null);
    });
  }, []);

  // § live UX review, user-directed - "the employee filter shouldn't
  // even appear on a plain employee's own screen, they only ever see
  // themselves." A single visible name (this viewer's own RLS-scoped
  // data always contains at least their own rows) means there is
  // nothing to filter - the dropdown itself is hidden rather than
  // shown with one pointless option.
  const employeeNames = useMemo(() => {
    const collator = new Intl.Collator(i18n.language, { sensitivity: "base" });
    return Array.from(new Set(rows.map((row) => row.userFullName))).sort(collator.compare);
  }, [rows, i18n.language]);
  const showEmployeeFilter = employeeNames.length > 1;
  const employeeOptions = useMemo(
    () => [{ value: ALL_EMPLOYEES, label: t("filters.allEmployees") }, ...employeeNames.map((name) => ({ value: name, label: name }))],
    [employeeNames, t],
  );

  useEffect(() => {
    if (employeeFilter !== ALL_EMPLOYEES && !rows.some((row) => row.userFullName === employeeFilter)) {
      setEmployeeFilter(ALL_EMPLOYEES);
    }
  }, [rows, employeeFilter]);

  const filteredRows = useMemo(
    () => (employeeFilter === ALL_EMPLOYEES ? rows : rows.filter((row) => row.userFullName === employeeFilter)),
    [rows, employeeFilter],
  );

  const handleExportPdf = async (mode: "save" | "print" = "save") => {
    setExportingPdf(true);
    try {
      const doc = await buildAttendanceLogPdf(filteredRows, startDate, endDate, i18n.language, t, organizationLogoUrl);
      if (mode === "print") await printPdfDocument(doc, exportFileName(t("title"), startDate, endDate));
      else await savePdfDocument(doc, exportFileName(t("title"), startDate, endDate), "attendance", startDate, endDate);
    } finally {
      setExportingPdf(false);
    }
  };

  const openEvidence = async (storagePath: string, title: string) => {
    setEvidenceModalTitle(title);
    setEvidenceUrl(null);
    setEvidenceError("");
    setEvidenceLoading(true);
    const result = await EvidenceRepository.getEvidenceObjectUrl(storagePath);
    setEvidenceLoading(false);
    if (!result.success || !result.data) {
      setEvidenceError(humanizeBackendError(result.message, t) ?? t("photoLoadError"));
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

  const columns: TableColumn<TodayAttendanceRow>[] = [
    { key: "name", header: t("columns.employee"), render: (row) => <PersonName name={row.userFullName} userId={row.userId} /> },
    {
      key: "site",
      header: t("columns.site"),
      render: (row) => (
        <span>
          {startingSiteName(row, t)}
          {row.siteChanges.map((change, index) => (
            <span key={index} style={{ display: "block", fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
              {t("siteChangedTo", { site: change.toSiteName, time: formatTimeOnly(change.changedAt, i18n.language) })}
            </span>
          ))}
        </span>
      ),
    },
    { key: "clockInLocation", header: t("columns.clockInLocation"), render: (row) => <LocationCell location={row.clockInLocation} t={t} /> },
    { key: "clockOutLocation", header: t("columns.clockOutLocation"), render: (row) => <LocationCell location={row.clockOutLocation} t={t} /> },
    {
      key: "clockInAt",
      header: t("columns.clockInAt"),
      render: (row) => (
        <span style={{ display: "block" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-1)" }}>
            {formatTimeOnly(row.clockInAt, i18n.language)}
            {row.clockInEvidencePath ? (
              <button
                type="button"
                onClick={() => openEvidence(row.clockInEvidencePath as string, `${row.userFullName} — ${t("columns.clockInAt")}`)}
                title={t("viewPhoto")}
                aria-label={t("viewPhoto")}
                style={{ display: "inline-flex", alignItems: "center", background: "none", border: "none", cursor: "pointer", color: "var(--text-link)", padding: 0 }}
              >
                <Camera size={14} />
              </button>
            ) : null}
          </span>
          {row.clockInRecordedByName ? (
            <span style={{ display: "block", fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
              {t("recordedByOnBehalf", { name: row.clockInRecordedByName })}
            </span>
          ) : null}
          {row.clockInDeviceTime ? <DeviceTimeBadge label={t("deviceTimeBadge")} hint={t("deviceTimeHint")} /> : null}
        </span>
      ),
    },
    {
      key: "clockOutAt",
      header: t("columns.clockOutAt"),
      render: (row) =>
        row.clockOutAt ? (
          <span style={{ display: "block" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-1)" }}>
              {formatTimeOnly(row.clockOutAt, i18n.language)}
              {row.clockOutEvidencePath ? (
                <button
                  type="button"
                  onClick={() => openEvidence(row.clockOutEvidencePath as string, `${row.userFullName} — ${t("columns.clockOutAt")}`)}
                  title={t("viewPhoto")}
                  aria-label={t("viewPhoto")}
                  style={{ display: "inline-flex", alignItems: "center", background: "none", border: "none", cursor: "pointer", color: "var(--text-link)", padding: 0 }}
                >
                  <Camera size={14} />
                </button>
              ) : null}
            </span>
            {row.clockOutRecordedByName ? (
              <span style={{ display: "block", fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
                {t("recordedByOnBehalf", { name: row.clockOutRecordedByName })}
              </span>
            ) : null}
            {row.clockOutDeviceTime ? <DeviceTimeBadge label={t("deviceTimeBadge")} hint={t("deviceTimeHint")} /> : null}
          </span>
        ) : (
          "—"
        ),
    },
    { key: "status", header: t("columns.status"), render: (row) => <StatusBadge status={row.status === "clocked_in" ? "active" : "neutral"}>{t(`status.${row.status}`)}</StatusBadge> },
    { key: "workedHours", header: t("columns.workedHours"), render: (row) => formatWorkedHours(row.clockInAt, row.clockOutAt) },
    { key: "notes", header: t("columns.notes"), render: (row) => <NotesCell row={row} t={t} time={(iso) => formatTimeOnly(iso, i18n.language)} /> },
  ];

  return (
    <PageShell title="">
      <PageBanner pageId="attendance" illustration={attendanceHeaderImage} />

      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "var(--space-4)" }}>
        <Button variant="ghost" onClick={() => handleExportPdf("print")} loading={exportingPdf} disabled={filteredRows.length === 0}>
          {t("common:actions.print")}
        </Button>
        <Button onClick={() => handleExportPdf()} loading={exportingPdf} disabled={filteredRows.length === 0}>
          {t("exportPdfAction")}
        </Button>
      </div>

      <Card title={t("filters.title")}>
        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginBottom: "var(--space-3)" }}>
          {PERIODS.map((period) => (
            <Button key={period} size="sm" variant={activePeriod === period ? "primary" : "ghost"} onClick={() => choosePeriod(period)}>
              {t(`periods.${period}`)}
            </Button>
          ))}
        </div>
        <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
          <DateRange>
            <Input label={t("filters.fromLabel")} name="attendanceLogFrom" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
            <Input label={t("filters.toLabel")} name="attendanceLogTo" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
          </DateRange>
          {showEmployeeFilter ? (
            <Select label={t("filters.employeeLabel")} name="attendanceLogEmployee" value={employeeFilter} onChange={(event) => setEmployeeFilter(event.target.value)} options={employeeOptions} />
          ) : null}
        </div>
      </Card>

      <Card>
        <ErrorText>{loadError}</ErrorText>
        <Table columns={columns} data={filteredRows} getRowId={(row) => row.sessionId} loading={loading} emptyMessage={t("empty")} />
        {!loading && filteredRows.length > 0 ? (
          <p style={{ margin: "var(--space-3) 0 0", fontSize: "var(--font-sm)", fontWeight: "var(--font-weight-semibold)", color: "var(--text-primary)" }}>
            {t("totalHours", { hours: formatHours(filteredRows.reduce((sum, row) => sum + sessionHours(row), 0)), count: filteredRows.length })}
          </p>
        ) : null}
      </Card>

      <Modal isOpen={Boolean(evidenceModalTitle)} onClose={closeEvidence} title={evidenceModalTitle ?? t("photoModalTitle")}>
        {evidenceLoading ? (
          <HintText>{t("photoLoading")}</HintText>
        ) : evidenceError ? (
          <ErrorText>{evidenceError}</ErrorText>
        ) : evidenceUrl ? (
          <img src={evidenceUrl} alt={t("photoAlt")} style={{ maxWidth: "100%", borderRadius: "var(--radius-md)", display: "block" }} />
        ) : null}
      </Modal>
    </PageShell>
  );
}
