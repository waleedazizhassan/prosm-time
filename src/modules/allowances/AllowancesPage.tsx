import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "../../core/context/AuthContext";
import AllowanceRepository, { type AllowanceEntry, type AllowanceEntryInput } from "../../core/repositories/AllowanceRepository";
import OrganizationRepository from "../../core/repositories/OrganizationRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import savePdfDocument from "../../core/utils/savePdfDocument";
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
import { buildAllowancesPdf } from "./allowancesPdf";
import allowancesHeaderImage from "../../assets/illustration-allowances-header.png";

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
export default function AllowancesPage() {
  const { t, i18n } = useTranslation("allowances");
  const { profile, hasPermission } = useAuth();
  const canApprove = hasPermission("allowances.approve");

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
  const [submitting, setSubmitting] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [reviewNotes, setReviewNotes] = useState("");
  const [reviewing, setReviewing] = useState<"approved" | "rejected" | null>(null);

  const [organizationLogoUrl, setOrganizationLogoUrl] = useState<string | null>(null);
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

  useEffect(() => {
    OrganizationRepository.getCurrentOrganization().then((result) => {
      setOrganizationLogoUrl(result.success ? (result.data?.logoUrl ?? null) : null);
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
  const isDraft = detailEntry?.status === "draft";
  const isSubmitted = detailEntry?.status === "submitted";
  const canEditDetail = isOwnEntry && isDraft;
  const canSubmitDetail = isOwnEntry && isDraft;
  const canReviewDetail = canApprove && isSubmitted && !isOwnEntry;

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

  const handleSubmitDetail = async () => {
    if (!detailEntry) return;
    setSubmitting(true);
    setDetailError("");
    const result = await AllowanceRepository.submitEntry(detailEntry.id);
    setSubmitting(false);
    if (!result.success) {
      setDetailError(humanizeBackendError(result.message, t) ?? t("submitError"));
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

  const handleExportPdf = async () => {
    setExportingPdf(true);
    try {
      const doc = await buildAllowancesPdf(filteredEntries, startDate, endDate, i18n.language, t, organizationLogoUrl);
      await savePdfDocument(doc, `allowances-${startDate}-${endDate}.pdf`, "allowances", startDate, endDate);
    } finally {
      setExportingPdf(false);
    }
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
    { key: "overtimeHours", header: t("columns.overtimeHours"), render: (entry) => entry.overtimeHours.toFixed(2) },
    { key: "overtimeDays", header: t("columns.overtimeDays"), render: (entry) => entry.overtimeDays.toFixed(1) },
    { key: "housing", header: t("columns.housing"), render: (entry) => entry.housingAllowance.toFixed(2) },
    { key: "travel", header: t("columns.travel"), render: (entry) => entry.travelAllowance.toFixed(2) },
    { key: "other", header: t("columns.other"), render: (entry) => entry.otherAllowance.toFixed(2) },
    { key: "status", header: t("columns.status"), render: (entry) => <StatusBadge status={STATUS_BADGE_KEY[entry.status]}>{t(`status.${entry.status}`)}</StatusBadge> },
  ];

  return (
    <PageShell title="">
      <img
        src={allowancesHeaderImage}
        alt=""
        style={{ display: "block", width: "20cm", height: "4.9cm", maxWidth: "100%", objectFit: "cover", margin: "0 auto var(--space-4)", borderRadius: "var(--radius-md)" }}
      />

      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "var(--space-4)" }}>
        <Button onClick={handleExportPdf} loading={exportingPdf} disabled={filteredEntries.length === 0}>
          {t("exportPdfAction")}
        </Button>
      </div>

      <Card title={t("filters.title")}>
        <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
          <Input label={t("filters.fromLabel")} name="allowancesFrom" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
          <Input label={t("filters.toLabel")} name="allowancesTo" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
          {showEmployeeFilter ? (
            <Select label={t("filters.employeeLabel")} name="allowancesEmployee" value={employeeFilter} onChange={(event) => setEmployeeFilter(event.target.value)} options={employeeOptions} />
          ) : null}
        </div>
      </Card>

      <Card title={t("addEntry.title")}>
        <p style={{ margin: "0 0 var(--space-2)", fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t("addEntry.hint")}</p>
        <ErrorText>{addError}</ErrorText>
        <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-end" }}>
          <Input label={t("addEntry.dateLabel")} name="newAllowanceEntryDate" type="date" value={newEntryDate} onChange={(event) => setNewEntryDate(event.target.value)} />
          <Button onClick={handleAddEntry} loading={addingEntry} disabled={!newEntryDate}>
            {t("addEntry.action")}
          </Button>
        </div>
      </Card>

      <Card>
        <ErrorText>{loadError}</ErrorText>
        <Table columns={columns} data={filteredEntries} getRowId={(entry) => entry.id} loading={loading} emptyMessage={t("empty")} onRowClick={openDetail} />
      </Card>

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
              {canSubmitDetail ? (
                <Button onClick={handleSubmitDetail} loading={submitting}>
                  {t("detail.submitAction")}
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
            <p style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
              {t("detail.siteLine", { site: detailEntry.siteName || "—" })}
              {detailEntry.clockInAt ? ` · ${t("detail.clockInLine", { time: formatTimeOnly(detailEntry.clockInAt, i18n.language) })}` : ""}
              {detailEntry.clockOutAt ? ` · ${t("detail.clockOutLine", { time: formatTimeOnly(detailEntry.clockOutAt, i18n.language) })}` : ""}
            </p>
            <p style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
              {t("detail.overtimeLine", { hours: detailEntry.overtimeHours.toFixed(2), days: detailEntry.overtimeDays.toFixed(1) })}
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
