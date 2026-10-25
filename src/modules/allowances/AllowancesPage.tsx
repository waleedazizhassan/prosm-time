import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";
import AllowanceRepository, { type AllowanceEntry, type AllowanceEntryInput, type AllowanceSheet } from "../../core/repositories/AllowanceRepository";
import AllowanceRatesRepository, { RATE_FIELDS, type MySiteRates } from "../../core/repositories/AllowanceRatesRepository";
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
import Textarea from "../../components/common/Textarea";
import { formatDateOnly, formatTimeOnly } from "../../core/utils/formatDate";
import { buildCombinedAllowanceSheetPdf, buildEmployeeAllowanceSheetPdf } from "./allowancesPdf";
import allowancesHeaderImage from "../../assets/illustrations/allowances.svg";
import PageBanner from "../../components/common/PageBanner";
import Toggle from "../../components/common/Toggle";
import HintText from "../../components/common/HintText";
import DateRange from "../../components/common/DateRange";

const ALL_EMPLOYEES = "";

const STATUS_BADGE_KEY: Record<AllowanceEntry["status"], string> = {
  draft: "draft",
  submitted: "pending",
  approved: "approved",
  rejected: "revoked",
};

const EMPTY_INPUT: AllowanceEntryInput = {
  mealAllowance: 0,
  expatriationAllowance: 0,
  transportationAllowance: 0,
  housingAllowance: 0,
  travelAllowance: 0,
  otherAllowance: 0,
  otherAllowanceNote: null,
};

// Owner 2026-10-20: a day's allowances in money - the amounts plus priced overtime and extra days.
function entryTotal(entry: AllowanceEntry): number {
  return (
    entry.mealAllowance +
    entry.expatriationAllowance +
    entry.transportationAllowance +
    entry.housingAllowance +
    entry.travelAllowance +
    entry.otherAllowance +
    entry.overtimeAmount +
    entry.extraDaysAmount
  );
}

const TOTALS: [string, (entry: AllowanceEntry) => number][] = [
  ["meal", (entry) => entry.mealAllowance],
  ["expatriation", (entry) => entry.expatriationAllowance],
  ["transportation", (entry) => entry.transportationAllowance],
  ["housing", (entry) => entry.housingAllowance],
  ["travel", (entry) => entry.travelAllowance],
  ["other", (entry) => entry.otherAllowance],
  ["overtimeAmount", (entry) => entry.overtimeAmount + entry.extraDaysAmount],
  ["total", entryTotal],
];

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// § real bug, live-tested: "these fields don't accept typing unless I
// select the 0 first and delete it." value={String(numericState)} +
// onChange doing Number(event.target.value) meant clearing the field
// (event.target.value === "") immediately coerced back to 0, so the
// controlled input snapped back to "0" on every single keystroke
// before the user's next digit could land - especially disruptive on
// mobile numeric keyboards. A genuine 0 now displays as an empty field
// (a placeholder shows "0" for the same visual default) so clearing it
// stays blank instead of fighting the re-render.
function amountFieldValue(amount: number): string {
  return amount === 0 ? "" : String(amount);
}

function parseAmountInput(raw: string): number {
  if (raw === "") return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

// PROSM Time - Allowances (2026-09-02 approved plan, Feature 2).
// "Date/day/site/clock in/out are auto-imported; the employee
// completes the rest" - an entry is created via "Add" for a chosen
// date (upsert_prosm_time_allowance_entry resolves the matching
// attendance session and the read-only overtime hours/days from
// Feature 1's own shift-policy computation server-side, the client
// never supplies them), then the employee fills in the amount fields
// and submits. Mirrors Timesheets' own draft -> submitted ->
// approved/rejected lifecycle exactly, per the user's explicit
// confirmation. No permission gate on the nav item itself (same
// reasoning as Timesheets/Attendance Record) - allowance_entries' own
// RLS already returns exactly what the caller may see.
// v2.3.43 step 4: overtime is kept in minutes - shown as h:mm (0:15, 8:20).
function formatMinutes(minutes: number): string {
  const total = Math.round(minutes);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export default function AllowancesPage() {
  const { t, i18n } = useTranslation("allowances");
  const { profile, hasPermission } = useAuth();
  const navigate = useNavigate();
  const canApprove = hasPermission("allowances.approve");
  const isOwner = Boolean(profile?.isOwner);
  const [myRates, setMyRates] = useState<MySiteRates[]>([]);
  const [filling, setFilling] = useState(false);
  const [fillMessage, setFillMessage] = useState("");

  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  const [startDate, setStartDate] = useState(isoDate(monthStart));
  const [endDate, setEndDate] = useState(isoDate(today));
  const [entries, setEntries] = useState<AllowanceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [employeeFilter, setEmployeeFilter] = useState(ALL_EMPLOYEES);

  const [newEntryDate, setNewEntryDate] = useState(isoDate(today));
  const [addingEntry, setAddingEntry] = useState(false);
  const [addError, setAddError] = useState("");

  const [detailEntry, setDetailEntry] = useState<AllowanceEntry | null>(null);
  const [formInput, setFormInput] = useState<AllowanceEntryInput>(EMPTY_INPUT);
  const [saving, setSaving] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [reviewNotes, setReviewNotes] = useState("");
  const [reviewing, setReviewing] = useState<"approved" | "rejected" | null>(null);

  const [organizationLogoUrl, setOrganizationLogoUrl] = useState<string | null>(null);
  const [organizationName, setOrganizationName] = useState("");
  const [exportingPdf, setExportingPdf] = useState(false);

  const load = useCallback(async () => {
    if (!startDate || !endDate) return;
    setLoading(true);
    setLoadError("");
    const result = await AllowanceRepository.listEntries(startDate, endDate);
    if (!result.success) {
      setLoadError(humanizeBackendError(result.message, t) ?? t("loadError"));
      setEntries([]);
      setLoading(false);
      return;
    }
    setEntries(result.data ?? []);
    setLoading(false);
  }, [startDate, endDate, t]);

  useEffect(() => {
    load();
  }, [load]);

  // The prices that apply to the reader (the Owner does not clock in, so has none).
  useEffect(() => {
    if (isOwner) return;
    AllowanceRatesRepository.myRates().then((result) => setMyRates(result.success ? (result.data ?? []) : []));
  }, [isOwner]);

  // Owner 2026-10-20: every day worked in the period, filled from the prices in one tap.
  // Owner 2026-10-20: auto-fill after each shift, and send the period's drafts to the manager at once.
  const [autoFill, setAutoFill] = useState(false);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (isOwner) return;
    AllowanceRepository.getAutoFill().then((result) => setAutoFill(Boolean(result.data)));
  }, [isOwner]);

  const handleAutoFill = async (enabled: boolean) => {
    setAutoFill(enabled);
    const result = await AllowanceRepository.setAutoFill(enabled);
    if (!result.success) {
      setAutoFill(!enabled);
      setAddError(humanizeBackendError(result.message, t) ?? t("saveError"));
    }
  };

  const unsentDays = entries.filter((entry) => entry.userId === profile?.id && (entry.status === "draft" || entry.status === "rejected")).length;

  const handleSendAll = async () => {
    setSending(true);
    setAddError("");
    setFillMessage("");
    const result = await AllowanceRepository.submitPeriod(startDate, endDate);
    setSending(false);
    if (!result.success) {
      setAddError(humanizeBackendError(result.message, t) ?? t("submitError"));
      return;
    }
    setFillMessage(t("sendAll.done", { count: result.data?.sent ?? 0 }));
    await load();
  };

  const handleFill = async () => {
    setFilling(true);
    setFillMessage("");
    setAddError("");
    const result = await AllowanceRepository.fillFromAttendance(startDate, endDate);
    setFilling(false);
    if (!result.success) {
      setAddError(humanizeBackendError(result.message, t) ?? t("addError"));
      return;
    }
    setFillMessage(t("fill.done", { count: result.data?.filled ?? 0 }));
    await load();
  };

  useEffect(() => {
    OrganizationRepository.getCurrentOrganization().then((result) => {
      setOrganizationLogoUrl(result.success ? (result.data?.logoUrl ?? null) : null);
      setOrganizationName(result.success ? (result.data?.name ?? "") : "");
    });
  }, []);

  // § live UX review, user-directed - hidden entirely on a plain
  // employee's own screen (same reasoning as Attendance Record).
  const employeeNames = useMemo(() => {
    const collator = new Intl.Collator(i18n.language, { sensitivity: "base" });
    return Array.from(new Set(entries.map((entry) => entry.userFullName))).sort(collator.compare);
  }, [entries, i18n.language]);
  const showEmployeeFilter = employeeNames.length > 1;
  const employeeOptions = useMemo(
    () => [{ value: ALL_EMPLOYEES, label: t("filters.allEmployees") }, ...employeeNames.map((name) => ({ value: name, label: name }))],
    [employeeNames, t],
  );

  useEffect(() => {
    if (employeeFilter !== ALL_EMPLOYEES && !entries.some((entry) => entry.userFullName === employeeFilter)) {
      setEmployeeFilter(ALL_EMPLOYEES);
    }
  }, [entries, employeeFilter]);

  const filteredEntries = useMemo(
    () => (employeeFilter === ALL_EMPLOYEES ? entries : entries.filter((entry) => entry.userFullName === employeeFilter)),
    [entries, employeeFilter],
  );

  const handleAddEntry = async () => {
    if (!newEntryDate) return;
    setAddingEntry(true);
    setAddError("");
    const result = await AllowanceRepository.upsertEntry(newEntryDate, EMPTY_INPUT);
    setAddingEntry(false);
    if (!result.success) {
      setAddError(humanizeBackendError(result.message, t) ?? t("addError"));
      return;
    }
    await load();
  };

  const openDetail = (entry: AllowanceEntry) => {
    setDetailEntry(entry);
    setFormInput({
      mealAllowance: entry.mealAllowance,
      expatriationAllowance: entry.expatriationAllowance,
      transportationAllowance: entry.transportationAllowance,
      housingAllowance: entry.housingAllowance,
      travelAllowance: entry.travelAllowance,
      otherAllowance: entry.otherAllowance,
      otherAllowanceNote: entry.otherAllowanceNote,
    });
    setDetailError("");
    setReviewNotes("");
  };

  const closeDetail = () => setDetailEntry(null);

  const isOwnEntry = detailEntry ? detailEntry.userId === profile?.id : false;
  const isSubmitted = detailEntry?.status === "submitted";
  // Owner 2026-10-18: editable until approved (a submitted entry stays waiting for review).
  const canEditDetail = isOwnEntry && detailEntry?.status !== "approved";
  const canReviewDetail = canApprove && isSubmitted && !isOwnEntry && !detailEntry?.sheetId;

  const handleSaveDetail = async () => {
    if (!detailEntry) return;
    setSaving(true);
    setDetailError("");
    const result = await AllowanceRepository.upsertEntry(detailEntry.entryDate, formInput);
    setSaving(false);
    if (!result.success) {
      setDetailError(humanizeBackendError(result.message, t) ?? t("saveError"));
      return;
    }
    closeDetail();
    await load();
  };


  const handleReview = async (action: "approved" | "rejected") => {
    if (!detailEntry) return;
    setReviewing(action);
    setDetailError("");
    const result = await AllowanceRepository.approveEntry(detailEntry.id, action, reviewNotes.trim() || undefined);
    setReviewing(null);
    if (!result.success) {
      setDetailError(humanizeBackendError(result.message, t) ?? t("reviewError"));
      return;
    }
    closeDetail();
    await load();
  };

  // Owner 2026-10-20: one person's entries print as their detailed sheet; several
  // people as a combined sheet of totals, for the people the reader picks.
  const sheetContext = () => ({ startDate, endDate, languageCode: i18n.language, t, organizationName, organizationLogoUrl });
  const peopleInView = useMemo(() => Array.from(new Set(filteredEntries.map((entry) => entry.userFullName))), [filteredEntries]);
  const [combinedOpen, setCombinedOpen] = useState(false);
  const [combinedPeople, setCombinedPeople] = useState<string[]>([]);
  const [combinedMode, setCombinedMode] = useState<"save" | "print">("save");

  const handleExportPdf = async (mode: "save" | "print" = "save") => {
    if (peopleInView.length > 1) {
      setCombinedPeople(peopleInView);
      setCombinedMode(mode);
      setCombinedOpen(true);
      return;
    }
    setExportingPdf(true);
    try {
      const name = peopleInView[0] ?? profile?.fullName ?? "";
      const doc = await buildEmployeeAllowanceSheetPdf(filteredEntries, name, sheetContext());
      const file = exportFileName(t("sheet.subtitle"), name, startDate, endDate);
      if (mode === "print") await printPdfDocument(doc, file);
      else await savePdfDocument(doc, file, "allowances", startDate, endDate);
    } finally {
      setExportingPdf(false);
    }
  };

  const handleExportCombined = async () => {
    setExportingPdf(true);
    try {
      const chosen = filteredEntries.filter((entry) => combinedPeople.includes(entry.userFullName));
      const doc = await buildCombinedAllowanceSheetPdf(chosen, sheetContext());
      const file = exportFileName(t("sheet.combinedSubtitle"), startDate, endDate);
      if (combinedMode === "print") await printPdfDocument(doc, file);
      else await savePdfDocument(doc, file, "allowances", startDate, endDate);
      setCombinedOpen(false);
    } finally {
      setExportingPdf(false);
    }
  };

  // Sheets waiting for the reader's decision (one decision per sheet).
  const [sheets, setSheets] = useState<AllowanceSheet[]>([]);
  const [sheetNotes, setSheetNotes] = useState<Record<string, string>>({});
  const [sheetBusy, setSheetBusy] = useState<string | null>(null);
  const [sheetError, setSheetError] = useState("");
  const loadSheets = useCallback(async () => {
    if (!canApprove && !isOwner) return;
    const result = await AllowanceRepository.listSheets("submitted");
    setSheets(result.success ? (result.data ?? []).filter((sheet) => sheet.userId !== profile?.id) : []);
  }, [canApprove, isOwner, profile?.id]);
  useEffect(() => {
    loadSheets();
  }, [loadSheets]);

  const decideSheet = async (sheet: AllowanceSheet, action: "approved" | "rejected") => {
    setSheetBusy(sheet.id);
    setSheetError("");
    const result = await AllowanceRepository.reviewSheet(sheet.id, action, sheetNotes[sheet.id]?.trim() || undefined);
    setSheetBusy(null);
    if (!result.success) {
      setSheetError(humanizeBackendError(result.message, t) ?? t("reviewError"));
      return;
    }
    await Promise.all([loadSheets(), load()]);
  };

  const openSheet = (sheet: AllowanceSheet) => {
    setStartDate(sheet.periodStart);
    setEndDate(sheet.periodEnd);
    setEmployeeFilter(sheet.userFullName);
  };

  const columns: TableColumn<AllowanceEntry>[] = [
    { key: "employee", header: t("columns.employee"), render: (entry) => entry.userFullName },
    { key: "date", header: t("columns.date"), render: (entry) => formatDateOnly(entry.entryDate, i18n.language) },
    { key: "day", header: t("columns.day"), render: (entry) => new Date(entry.entryDate).toLocaleDateString(i18n.language, { weekday: "long" }) },
    { key: "site", header: t("columns.site"), render: (entry) => entry.siteName || "—" },
    { key: "clockIn", header: t("columns.clockIn"), render: (entry) => (entry.clockInAt ? formatTimeOnly(entry.clockInAt, i18n.language) : "—") },
    { key: "clockOut", header: t("columns.clockOut"), render: (entry) => (entry.clockOutAt ? formatTimeOnly(entry.clockOutAt, i18n.language) : "—") },
    { key: "meal", header: t("columns.meal"), render: (entry) => entry.mealAllowance.toFixed(2) },
    { key: "expatriation", header: t("columns.expatriation"), render: (entry) => entry.expatriationAllowance.toFixed(2) },
    { key: "transportation", header: t("columns.transportation"), render: (entry) => entry.transportationAllowance.toFixed(2) },
    { key: "overtimeHours", header: t("columns.overtimeHours"), render: (entry) => formatMinutes(entry.overtimeMinutes) },
    { key: "overtimeDays", header: t("columns.overtimeDays"), render: (entry) => entry.overtimeDays.toFixed(1) },
    { key: "housing", header: t("columns.housing"), render: (entry) => entry.housingAllowance.toFixed(2) },
    { key: "travel", header: t("columns.travel"), render: (entry) => entry.travelAllowance.toFixed(2) },
    { key: "other", header: t("columns.other"), render: (entry) => entry.otherAllowance.toFixed(2) },
    { key: "overtimeAmount", header: t("columns.overtimeAmount"), render: (entry) => (entry.overtimeAmount + entry.extraDaysAmount).toFixed(2) },
    { key: "total", header: t("columns.total"), render: (entry) => <strong>{entryTotal(entry).toFixed(2)}</strong> },
    { key: "status", header: t("columns.status"), render: (entry) => <StatusBadge status={STATUS_BADGE_KEY[entry.status]}>{t(`status.${entry.status}`)}</StatusBadge> },
  ];

  return (
    <PageShell title="">
      <PageBanner pageId="allowances" illustration={allowancesHeaderImage} />

      <div style={{ display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: "var(--space-2)", marginBottom: "var(--space-4)" }}>
        {canApprove || isOwner ? (
          <Button variant="ghost" onClick={() => navigate("/allowances/prices")}>
            {t("prices.openAction")}
          </Button>
        ) : null}
        <Button variant="ghost" onClick={() => handleExportPdf("print")} loading={exportingPdf} disabled={filteredEntries.length === 0}>
          {t("common:actions.print")}
        </Button>
        <Button onClick={() => handleExportPdf()} loading={exportingPdf} disabled={filteredEntries.length === 0}>
          {t("exportPdfAction")}
        </Button>
      </div>

      <Card title={t("filters.title")}>
        <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
          <DateRange>
            <Input label={t("filters.fromLabel")} name="allowancesFrom" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
            <Input label={t("filters.toLabel")} name="allowancesTo" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
          </DateRange>
          {showEmployeeFilter ? (
            <Select label={t("filters.employeeLabel")} name="allowancesEmployee" value={employeeFilter} onChange={(event) => setEmployeeFilter(event.target.value)} options={employeeOptions} />
          ) : null}
        </div>
      </Card>

      {isOwner ? null : (
        <Card title={t("addEntry.title")} subtitle={t("fill.hint")}>
          <ErrorText>{addError}</ErrorText>
          {fillMessage ? <p style={{ margin: "0 0 var(--space-3)", fontSize: "var(--font-sm)", color: "var(--status-success-text)" }}>{fillMessage}</p> : null}
          {/* Owner 2026-10-21 ("the buttons and the layout"): the two main actions side by side, the same size;
              then adding a single day on one row; then auto-fill. */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-3)" }}>
            <Button fullWidth onClick={handleFill} loading={filling}>
              {t("fill.action")}
            </Button>
            <Button fullWidth variant="ghost" onClick={handleSendAll} loading={sending} disabled={unsentDays === 0}>
              {unsentDays > 0 ? `${t("sendAll.action")} (${unsentDays})` : t("sendAll.action")}
            </Button>
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: "var(--space-3)", marginTop: "var(--space-4)" }}>
            <div style={{ flex: 1, minWidth: 0, marginBottom: "calc(-1 * var(--space-4))" }}>
              <Input label={t("addEntry.dateLabel")} name="newAllowanceEntryDate" type="date" value={newEntryDate} onChange={(event) => setNewEntryDate(event.target.value)} />
            </div>
            <Button variant="ghost" onClick={handleAddEntry} loading={addingEntry} disabled={!newEntryDate}>
              {t("addEntry.action")}
            </Button>
          </div>
          <label style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-3)", marginTop: "var(--space-5)", paddingTop: "var(--space-4)", borderTop: "1px solid var(--border-light)", fontSize: "var(--font-sm)" }}>
            <Toggle checked={autoFill} onChange={handleAutoFill} label={t("autoFill.label")} />
            <span>
              <strong>{t("autoFill.label")}</strong>
              <HintText small>{t("autoFill.hint")}</HintText>
            </span>
          </label>
        </Card>
      )}

      {sheets.length > 0 ? (
        <Card title={t("sheets.title")} subtitle={t("sheets.hint")}>
          <ErrorText>{sheetError}</ErrorText>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            {sheets.map((sheet) => (
              <div key={sheet.id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--space-3)", padding: "var(--space-3)", border: "1px solid var(--border-light)", borderRadius: "var(--radius-md)" }}>
                <div style={{ flex: "1 1 220px" }}>
                  <strong>{sheet.userFullName}</strong>
                  <HintText small>
                    {t("sheets.line", { from: formatDateOnly(sheet.periodStart, i18n.language), to: formatDateOnly(sheet.periodEnd, i18n.language), days: sheet.days, total: sheet.total.toLocaleString(i18n.language) })}
                  </HintText>
                </div>
                <input
                  aria-label={t("detail.reviewNotesLabel")}
                  placeholder={t("detail.reviewNotesLabel")}
                  value={sheetNotes[sheet.id] ?? ""}
                  onChange={(event) => setSheetNotes((current) => ({ ...current, [sheet.id]: event.target.value }))}
                  style={{ flex: "1 1 180px", minHeight: 36, padding: "0 var(--space-3)", border: "1px solid var(--border-medium)", borderRadius: "var(--radius-sm)", background: "var(--surface-raised)", color: "var(--text-primary)", font: "inherit" }}
                />
                <div style={{ display: "flex", gap: "var(--space-2)" }}>
                  <Button size="sm" variant="ghost" onClick={() => openSheet(sheet)}>
                    {t("sheets.openAction")}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => decideSheet(sheet, "rejected")} loading={sheetBusy === sheet.id}>
                    {t("detail.rejectAction")}
                  </Button>
                  <Button size="sm" onClick={() => decideSheet(sheet, "approved")} loading={sheetBusy === sheet.id}>
                    {t("detail.approveAction")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <Modal
        isOpen={combinedOpen}
        onClose={() => setCombinedOpen(false)}
        title={t("sheet.combinedTitle")}
        footer={
          <Button onClick={handleExportCombined} loading={exportingPdf} disabled={combinedPeople.length === 0}>
            {combinedMode === "print" ? t("common:actions.print") : t("exportPdfAction")}
          </Button>
        }
      >
        <HintText small>{t("sheet.combinedHint")}</HintText>
        <div style={{ display: "flex", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
          <Button size="xs" variant="ghost" onClick={() => setCombinedPeople(peopleInView)}>
            {t("sheet.selectAll")}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setCombinedPeople([])}>
            {t("sheet.selectNone")}
          </Button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          {peopleInView.map((name) => (
            <label key={name} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--font-sm)" }}>
              <input
                type="checkbox"
                checked={combinedPeople.includes(name)}
                onChange={(event) => setCombinedPeople((current) => (event.target.checked ? [...current, name] : current.filter((other) => other !== name)))}
              />
              {name}
            </label>
          ))}
        </div>
      </Modal>

      <Card flush>
        <ErrorText>{loadError}</ErrorText>
        <Table columns={columns} data={filteredEntries} getRowId={(entry) => entry.id} loading={loading} emptyMessage={t("empty")} onRowClick={openDetail} />
      </Card>

      {filteredEntries.length > 0 ? (
        <Card title={t("totals.title")}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "var(--space-3)" }}>
            {TOTALS.map(([key, pick]) => (
              <div key={key} style={{ padding: "var(--space-3)", borderRadius: "var(--radius-md)", background: key === "total" ? "var(--brand-gradient-soft), var(--surface-sunken)" : "var(--surface-sunken)" }}>
                <div style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t(`columns.${key}`)}</div>
                <div style={{ fontSize: "var(--font-lg)", fontWeight: 700 }}>{filteredEntries.reduce((sum, entry) => sum + pick(entry), 0).toFixed(2)}</div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {myRates.length > 0 ? (
        <Card title={t("myPrices.title")} subtitle={t("myPrices.hint")} flush>
          <Table
            columns={[
              { key: "site", header: t("columns.site"), render: (row: MySiteRates) => row.siteName },
              ...RATE_FIELDS.map((field) => ({
                key: field,
                header: t(`prices.field.${field}`),
                render: (row: MySiteRates) => (row.rates[field] === null || row.rates[field] === undefined ? "—" : Number(row.rates[field]).toFixed(2)),
              })),
            ]}
            data={myRates}
            getRowId={(row) => row.siteId}
            emptyMessage=""
          />
        </Card>
      ) : null}

      <Modal
        isOpen={Boolean(detailEntry)}
        onClose={closeDetail}
        title={detailEntry ? `${detailEntry.userFullName} — ${formatDateOnly(detailEntry.entryDate, i18n.language)}` : ""}
        footer={
          detailEntry ? (
            <>
              {canEditDetail ? (
                <Button variant="ghost" onClick={handleSaveDetail} loading={saving}>
                  {t("detail.saveAction")}
                </Button>
              ) : null}
              {canReviewDetail ? (
                <>
                  <Button variant="danger" onClick={() => handleReview("rejected")} loading={reviewing === "rejected"}>
                    {t("detail.rejectAction")}
                  </Button>
                  <Button onClick={() => handleReview("approved")} loading={reviewing === "approved"}>
                    {t("detail.approveAction")}
                  </Button>
                </>
              ) : null}
            </>
          ) : null
        }
      >
        {detailEntry ? (
          <>
            {detailEntry.reviewNotes && detailEntry.status !== "submitted" ? (
              <p style={{ fontSize: "var(--font-sm)", color: detailEntry.status === "rejected" ? "var(--brand-danger)" : "var(--text-secondary)" }}>
                {t("detail.reviewNotesLine", { notes: detailEntry.reviewNotes })}
              </p>
            ) : null}
            <p style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
              {t("detail.siteLine", { site: detailEntry.siteName || "—" })}
              {detailEntry.clockInAt ? ` · ${t("detail.clockInLine", { time: formatTimeOnly(detailEntry.clockInAt, i18n.language) })}` : ""}
              {detailEntry.clockOutAt ? ` · ${t("detail.clockOutLine", { time: formatTimeOnly(detailEntry.clockOutAt, i18n.language) })}` : ""}
            </p>
            {detailEntry.sessionCount > 1 ? (
              <p style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
                {t("detail.daySessionsLine", { count: detailEntry.sessionCount, hours: Math.floor(detailEntry.workedMinutes / 60), minutes: detailEntry.workedMinutes % 60 })}
              </p>
            ) : null}
            <p style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
              {t("detail.overtimeLine", { hours: formatMinutes(detailEntry.overtimeMinutes), days: detailEntry.overtimeDays.toFixed(1) })}
              {detailEntry.overtimeAmount + detailEntry.extraDaysAmount > 0
                ? ` · ${t("detail.overtimeValueLine", { amount: (detailEntry.overtimeAmount + detailEntry.extraDaysAmount).toFixed(2) })}`
                : ""}
            </p>

            <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
              <Input
                label={t("columns.meal")}
                name="mealAllowance"
                type="number"
                placeholder="0"
                value={amountFieldValue(formInput.mealAllowance)}
                onChange={(event) => setFormInput((current) => ({ ...current, mealAllowance: parseAmountInput(event.target.value) }))}
                disabled={!canEditDetail}
              />
              <Input
                label={t("columns.expatriation")}
                name="expatriationAllowance"
                type="number"
                placeholder="0"
                value={amountFieldValue(formInput.expatriationAllowance)}
                onChange={(event) => setFormInput((current) => ({ ...current, expatriationAllowance: parseAmountInput(event.target.value) }))}
                disabled={!canEditDetail}
              />
              <Input
                label={t("columns.transportation")}
                name="transportationAllowance"
                type="number"
                placeholder="0"
                value={amountFieldValue(formInput.transportationAllowance)}
                onChange={(event) => setFormInput((current) => ({ ...current, transportationAllowance: parseAmountInput(event.target.value) }))}
                disabled={!canEditDetail}
              />
              <Input
                label={t("columns.housing")}
                name="housingAllowance"
                type="number"
                placeholder="0"
                value={amountFieldValue(formInput.housingAllowance)}
                onChange={(event) => setFormInput((current) => ({ ...current, housingAllowance: parseAmountInput(event.target.value) }))}
                disabled={!canEditDetail}
              />
              <Input
                label={t("columns.travel")}
                name="travelAllowance"
                type="number"
                placeholder="0"
                value={amountFieldValue(formInput.travelAllowance)}
                onChange={(event) => setFormInput((current) => ({ ...current, travelAllowance: parseAmountInput(event.target.value) }))}
                disabled={!canEditDetail}
              />
              <Input
                label={t("columns.other")}
                name="otherAllowance"
                type="number"
                placeholder="0"
                value={amountFieldValue(formInput.otherAllowance)}
                onChange={(event) => setFormInput((current) => ({ ...current, otherAllowance: parseAmountInput(event.target.value) }))}
                disabled={!canEditDetail}
              />
            </div>
            <Textarea
              label={t("detail.otherNoteLabel")}
              name="otherAllowanceNote"
              value={formInput.otherAllowanceNote ?? ""}
              onChange={(event) => setFormInput((current) => ({ ...current, otherAllowanceNote: event.target.value || null }))}
              disabled={!canEditDetail}
            />

            {canReviewDetail ? (
              <Textarea label={t("detail.reviewNotesLabel")} name="reviewNotes" value={reviewNotes} onChange={(event) => setReviewNotes(event.target.value)} disabled={Boolean(reviewing)} />
            ) : null}

            <ErrorText>{detailError}</ErrorText>
          </>
        ) : null}
      </Modal>
    </PageShell>
  );
}
