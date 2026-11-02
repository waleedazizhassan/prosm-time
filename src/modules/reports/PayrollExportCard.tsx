import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import PayrollRepository, { type PayrollRow, type PayrollTemplate } from "../../core/repositories/PayrollRepository";
import saveGeneratedFile from "../../core/utils/saveGeneratedFile";
import { toCsv, toXlsx, type Cell } from "../../core/utils/spreadsheet";
import Button from "../../components/common/Button";
import Card from "../../components/common/Card";
import DateRange from "../../components/common/DateRange";
import ErrorText from "../../components/common/ErrorText";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";

const hours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;

const COLUMNS: Record<string, (row: PayrollRow) => Cell> = {
  name: (row) => row.fullName,
  email: (row) => row.email,
  daysWorked: (row) => row.daysWorked,
  workedHours: (row) => hours(row.workedMinutes),
  overtimeHours: (row) => hours(row.overtimeMinutes),
  weightedOvertimeHours: (row) => hours(row.overtimeWeightedMinutes),
  lateMinutes: (row) => row.lateMinutes,
  earlyLeaveMinutes: (row) => row.earlyLeaveMinutes,
  deductionMinutes: (row) => row.deductionMinutes,
  absenceDays: (row) => row.absenceDays,
  paidLeaveDays: (row) => row.paidLeaveDays,
  unpaidLeaveDays: (row) => row.unpaidLeaveDays,
  leaveDeduction: (row) => row.leaveDeduction,
  allowances: (row) => row.allowances,
  overtimeAmount: (row) => row.overtimeAmount,
  currency: (row) => row.currency,
};
const ALL_COLUMNS = Object.keys(COLUMNS);
const ALL = "";

// Plan stage 8.1: one row per person for a period, for the organisation's
// accountant. It adds up what the app holds and calculates no salary.
export default function PayrollExportCard({ startDate, endDate }: { startDate: string; endDate: string }) {
  const { t, i18n } = useTranslation("reports");
  const [allowed, setAllowed] = useState(false);
  const [from, setFrom] = useState(startDate);
  const [to, setTo] = useState(endDate);
  const [templates, setTemplates] = useState<PayrollTemplate[]>([]);
  const [templateId, setTemplateId] = useState(ALL);
  const [columns, setColumns] = useState(ALL_COLUMNS);
  const [templateName, setTemplateName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadTemplates = useCallback(() => void PayrollRepository.listTemplates().then(setTemplates), []);

  useEffect(() => {
    void PayrollRepository.canExport().then((can) => {
      setAllowed(can);
      if (can) loadTemplates();
    });
  }, [loadTemplates]);

  const templateOptions = useMemo(() => [{ value: ALL, label: t("payroll.allColumns") }, ...templates.map((template) => ({ value: template.id, label: template.name }))], [templates, t]);

  if (!allowed) return null;

  const chooseTemplate = (id: string) => {
    setTemplateId(id);
    const template = templates.find((entry) => entry.id === id);
    setColumns(template ? template.columns.filter((key) => key in COLUMNS) : ALL_COLUMNS);
  };

  const toggle = (key: string) => setColumns((current) => (current.includes(key) ? current.filter((entry) => entry !== key) : ALL_COLUMNS.filter((entry) => entry === key || current.includes(entry))));

  const download = async (format: "csv" | "xlsx") => {
    setBusy(true);
    setError("");
    const { rows, error: failed } = await PayrollRepository.list(from, to);
    if (failed) {
      setError(/PERIOD TOO LONG/.test(failed) ? t("payroll.periodTooLong") : t("loadError"));
      setBusy(false);
      return;
    }
    const table: Cell[][] = [columns.map((key) => t(`payroll.columns.${key}`)), ...rows.map((row) => columns.map((key) => COLUMNS[key](row)))];
    const name = `${t("payroll.title")} ${from} ${to}.${format}`;
    const blob =
      format === "csv"
        ? new Blob([toCsv(table)], { type: "text/csv;charset=utf-8" })
        : new Blob([toXlsx(table, i18n.language === "ar").slice().buffer as ArrayBuffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    await saveGeneratedFile(name, blob);
    setBusy(false);
  };

  const saveTemplate = async () => {
    if (await PayrollRepository.saveTemplate(templateName, columns)) {
      setTemplateName("");
      loadTemplates();
    } else setError(t("payroll.templateFailed"));
  };

  const deleteTemplate = async () => {
    if (await PayrollRepository.deleteTemplate(templateId)) {
      chooseTemplate(ALL);
      loadTemplates();
    } else setError(t("payroll.templateFailed"));
  };

  return (
    <Card title={t("payroll.title")} subtitle={t("payroll.subtitle")}>
      <DateRange>
        <Input label={t("filters.fromLabel")} name="payrollFrom" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        <Input label={t("filters.toLabel")} name="payrollTo" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
      </DateRange>
      <Select label={t("payroll.template")} name="payrollTemplate" value={templateId} onChange={(event) => chooseTemplate(event.target.value)} options={templateOptions} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "var(--space-2)", margin: "var(--space-3) 0" }}>
        {ALL_COLUMNS.map((key) => (
          <label key={key} style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", fontSize: "var(--font-sm)" }}>
            <input type="checkbox" checked={columns.includes(key)} onChange={() => toggle(key)} />
            {t(`payroll.columns.${key}`)}
          </label>
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "flex-end" }}>
        <Input label={t("payroll.templateName")} name="payrollTemplateName" value={templateName} onChange={(event) => setTemplateName(event.target.value)} />
        <Button variant="ghost" onClick={saveTemplate} disabled={!templateName.trim() || columns.length === 0}>
          {t("payroll.saveTemplate")}
        </Button>
        {templateId ? (
          <Button variant="ghost" onClick={deleteTemplate}>
            {t("payroll.deleteTemplate")}
          </Button>
        ) : null}
      </div>
      <ErrorText>{error}</ErrorText>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
        <Button onClick={() => download("xlsx")} loading={busy} disabled={busy || columns.length === 0 || !from || !to}>
          {t("payroll.excel")}
        </Button>
        <Button variant="ghost" onClick={() => download("csv")} loading={busy} disabled={busy || columns.length === 0 || !from || !to}>
          {t("payroll.csv")}
        </Button>
      </div>
    </Card>
  );
}
