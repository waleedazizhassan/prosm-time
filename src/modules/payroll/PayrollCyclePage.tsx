import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, Link } from "react-router-dom";

import PayrollCycleRepository, {
  type ExportJob,
  type CycleDetail, type CycleEmployee, type CycleLine, type PayrollComponent, type ReportType, type Suggestion, type ValidationItem,
} from "../../core/repositories/PayrollCycleRepository";
import SiteRepository from "../../core/repositories/SiteRepository";
import { formatDateOnly } from "../../core/utils/formatDate";
import savePdfDocument, { exportFileName } from "../../core/utils/savePdfDocument";
import { toCsv } from "../../core/utils/spreadsheet";
import saveGeneratedFile from "../../core/utils/saveGeneratedFile";
import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Textarea from "../../components/common/Textarea";
import Modal from "../../components/common/Modal";
import Table, { type TableColumn } from "../../components/common/Table";
import StatusBadge from "../../components/common/StatusBadge";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import LoadingState from "../../components/common/LoadingState";
import { STATUS_BADGE, money, parseAmount, parseCsv, payrollError, saveXlsx } from "./payrollUi";
import usePayrollDigits from "./usePayrollDigits";
import { buildPayslipsPdf, buildReportXlsx, buildSummaryPdf } from "./payrollDocuments";
import SuccessText from "../../components/common/SuccessText";

type Action = "submit" | "return" | "approve" | "lock" | "reopen" | "cancel";
const NEEDS_REASON: Action[] = ["return", "reopen", "cancel"];

// 2026-11-08: one payroll cycle - its people and lines, variable entry, attendance suggestions
// (never applied by themselves), checks before review, the workflow, the three reports, publishing
// and the spreadsheet import. Every button is also checked by the server.
export default function PayrollCyclePage() {
  const { cycleId = "" } = useParams();
  const { t, i18n } = useTranslation("payroll");
  usePayrollDigits();
  const navigate = useNavigate();
  const isRtl = i18n.dir() === "rtl";
  const [detail, setDetail] = useState<CycleDetail | null>(null);
  const [components, setComponents] = useState<PayrollComponent[]>([]);
  const [checks, setChecks] = useState<{ errors: ValidationItem[]; warnings: ValidationItem[] } | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [open, setOpen] = useState<CycleEmployee | null>(null);
  const [line, setLine] = useState<{ id: string | null; componentId: string; amount: string; notes: string; version: number | null } | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState("");
  const [acknowledge, setAcknowledge] = useState(false);
  const [accepting, setAccepting] = useState<{ s: Suggestion; componentId: string; amount: string } | null>(null);
  // 2026-11-09 (spec 15.14): search, sort and choose people; one line for the chosen ones
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"name" | "net" | "code">("name");
  const [chosen, setChosen] = useState<string[]>([]);
  const [bulk, setBulk] = useState<{ componentId: string; amount: string; notes: string } | null>(null);
  const [notice, setNotice] = useState("");
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  // spec 8.1: export the organisation (the cycle's scope), one site, or the chosen people
  const [exportScope, setExportScope] = useState<string>("all");
  const [siteNames, setSiteNames] = useState<Record<string, string>>({});
  const [importResult, setImportResult] = useState<{ errors: { row: number; code: string }[]; valid: number; saved: boolean; rows: Record<string, unknown>[]; fileName: string } | null>(null);

  // demo run 2026-11-12: payslips published while "employee self-service" is off reach nobody - say so
  const [selfService, setSelfService] = useState(true);
  useEffect(() => {
    void PayrollCycleRepository.getSettings().then((r) => { if (r.data) setSelfService(Boolean(r.data.employee_self_service)); });
  }, []);

  const load = useCallback(async () => {
    const [cycle, comps, validation] = await Promise.all([
      PayrollCycleRepository.getCycle(cycleId), PayrollCycleRepository.listComponents(), PayrollCycleRepository.validate(cycleId),
    ]);
    if (cycle.error) setError(payrollError(cycle.error, t));
    setDetail(cycle.data);
    setComponents(comps.data ?? []);
    setChecks(validation.data);
    if (cycle.data && ["draft", "reopened"].includes(cycle.data.cycle.status) && cycle.data.can.enterVariables) {
      setSuggestions((await PayrollCycleRepository.suggestions(cycleId)).data ?? []);
    } else setSuggestions([]);
    setOpen((current) => (current && cycle.data ? cycle.data.employees.find((e) => e.id === current.id) ?? null : current));
  }, [cycleId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // spec 15.11: the background exports of this cycle; refreshed while one is still working
  useEffect(() => {
    SiteRepository.listSites().then((result) => setSiteNames(Object.fromEntries((result.data ?? []).map((site) => [site.id, site.name]))));
  }, []);

  const loadJobs = useCallback(async () => {
    const result = await PayrollCycleRepository.listExportJobs(cycleId);
    setJobs(result.data ?? []);
  }, [cycleId]);
  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);
  const working = jobs.some((job) => job.status === "queued" || job.status === "running");
  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => void loadJobs(), 3000);
    return () => window.clearInterval(timer);
  }, [working, loadJobs]);

  // a line or a bulk line being typed is not lost by leaving the page by accident
  const dirty = Boolean((line && (line.amount || line.notes)) || (bulk && (bulk.amount || bulk.notes)));
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Amount boxes accept Arabic digits (owner 2026-11-09: "the fields don't save"); a bad number is said
  // inside the open window instead of silently becoming 0.
  const amountOf = (text: string): number | null => {
    const value = parseAmount(text);
    if (value === null || Number.isNaN(value) || value < 0) {
      setError(t("profiles.badNumber", { field: t("lines.amount") }));
      return null;
    }
    return value;
  };
  const modalError = error ? <ErrorText>{error}</ErrorText> : null;

  const run = async (key: string, task: () => Promise<{ error: string | null }>) => {
    setBusy(key);
    setError("");
    setNotice("");
    const result = await task();
    setBusy("");
    if (result.error) setError(payrollError(result.error, t));
    else setNotice(t("profiles.savedShort"));
    await load();
    return !result.error;
  };

  const variableComponents = useMemo(() => components.filter((c) => c.is_active && c.source === "variable" && c.calc_type === "amount"), [components]);
  if (!detail) return <PageShell title={t("cycle.loading")}>{error ? <ErrorText>{error}</ErrorText> : <LoadingState />}</PageShell>;

  const { cycle, can, employees } = detail;
  const editable = cycle.status === "draft" || cycle.status === "reopened";
  const currencies = [...new Set(employees.map((e) => e.currency))];
  const needle = search.trim().toLowerCase();
  const shown = employees
    .filter((e) => !needle || e.full_name.toLowerCase().includes(needle) || (e.employee_code ?? "").toLowerCase().includes(needle))
    .sort((x, y) => (sortBy === "net" ? Number(y.net_salary) - Number(x.net_salary) : sortBy === "code" ? (x.employee_code ?? "").localeCompare(y.employee_code ?? "", undefined, { numeric: true }) : x.full_name.localeCompare(y.full_name)));
  const canBulk = editable && can.enterVariables;
  const exportSites = [...new Set(employees.map((e) => e.site_id).filter((id): id is string => Boolean(id)))];
  // the chosen rows are cycle-employee ids; the reports take people's ids
  const exportUserIds = () => (exportScope === "chosen" ? employees.filter((e) => chosen.includes(e.id)).map((e) => e.user_id) : null);
  const exportSiteUserIds = () => (exportScope.startsWith("site:") ? employees.filter((e) => e.site_id === exportScope.slice(5)).map((e) => e.user_id) : exportUserIds());
  const toggle = (id: string) => setChosen((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));

  const doAction = async () => {
    if (!action) return;
    if (NEEDS_REASON.includes(action) && !reason.trim()) {
      setError(t("errors.reasonRequired"));
      return;
    }
    const ok = await run(action, () => PayrollCycleRepository.transition(cycleId, action, reason.trim() || null, cycle.row_version, acknowledge));
    if (ok) {
      setAction(null);
      setReason("");
      setAcknowledge(false);
    }
  };

  const exportReport = async (type: ReportType, format: "pdf" | "xlsx") => {
    setBusy(`${type}-${format}`);
    setError("");
    const result = await PayrollCycleRepository.report(cycleId, type, format, exportUserIds(), exportScope.startsWith("site:") ? [exportScope.slice(5)] : null);
    if (result.error || !result.data) {
      setBusy("");
      setError(payrollError(result.error, t));
      return;
    }
    const report = result.data;
    const base = exportFileName(t(`reports.${type}`), cycle.title, `v${report.cycle.cycleVersion}`, report.serial ? `#${report.serial}` : null).replace(/\.pdf$/, "");
    try {
      if (format === "xlsx") await saveXlsx(`${base}.xlsx`, buildReportXlsx(report, t, isRtl, type === "combined"));
      else {
        const doc = type === "payslip" ? await buildPayslipsPdf(report, t, isRtl) : await buildSummaryPdf(report, t, isRtl, type === "combined");
        if (doc) await savePdfDocument(doc, `${base}.pdf`);
      }
      if (report.excluded.length > 0) setError(t("reports.excluded", { count: report.excluded.length }));
    } catch {
      setError(t("errors.fileFailed"));
    }
    setBusy("");
  };

  const importFile = async (file: File) => {
    const rows = parseCsv(await file.text());
    const [head, ...body] = rows;
    const index = (name: string) => head?.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase()) ?? -1;
    const at = (row: string[], name: string) => (index(name) >= 0 ? row[index(name)] : "");
    const data = body.map((row) => ({ email: at(row, "email"), employeeCode: at(row, "employee_code"), component: at(row, "component"), amount: at(row, "amount").replace(/,/g, ""), notes: at(row, "notes") || null }));
    const dry = await PayrollCycleRepository.importLines(cycleId, data, file.name, true);
    if (dry.error || !dry.data) {
      setError(payrollError(dry.error, t));
      return;
    }
    setImportResult({ ...dry.data, rows: data, fileName: file.name });
  };

  const template = async () => {
    const rows = [["email", "employee_code", "component", "amount", "notes"], ...employees.map((e) => ["", e.employee_code ?? "", variableComponents[0]?.name_ar ?? "", "", ""])];
    await saveGeneratedFile(`${t("import.templateName")}.csv`, new Blob(["\uFEFF" + toCsv(rows)], { type: "text/csv;charset=utf-8" }));
  };

  const columns: TableColumn<CycleEmployee>[] = [
    { key: "name", header: t("cycle.employee"), render: (e) => <strong>{e.full_name}{e.employee_code ? ` · ${e.employee_code}` : ""}</strong> },
    { key: "earnings", header: t("doc.totalEarnings"), render: (e) => money(e.total_earnings) },
    { key: "deductions", header: t("doc.totalDeductions"), render: (e) => money(e.total_deductions) },
    { key: "installments", header: t("doc.totalInstallments"), render: (e) => money(e.total_installments) },
    { key: "net", header: t("doc.net"), render: (e) => <strong>{money(e.net_salary)} {e.currency}</strong>, sortValue: (e) => e.net_salary },
    { key: "combined", header: t("doc.combined"), render: (e) => money(e.combined_total) },
    { key: "flags", header: "", render: (e) => (!e.has_profile ? <StatusBadge status="inactive">{t("cycle.noProfile")}</StatusBadge> : e.proration_factor < 1 ? <StatusBadge status="pending">{t("cycle.partial", { percent: Math.round(e.proration_factor * 100) })}</StatusBadge> : null) },
  ];

  const actions: { key: Action; show: boolean; variant?: "primary" | "ghost" | "danger" }[] = [
    { key: "submit", show: editable && can.edit },
    { key: "return", show: cycle.status === "in_review" && can.review, variant: "ghost" },
    { key: "approve", show: cycle.status === "in_review" && can.approve },
    { key: "lock", show: cycle.status === "approved" && can.approve },
    { key: "reopen", show: (cycle.status === "approved" || cycle.status === "locked") && can.reopen, variant: "ghost" },
    { key: "cancel", show: (editable || cycle.status === "in_review") && can.edit, variant: "danger" },
  ];

  return (
    <PageShell title={cycle.title} subtitle={`${formatDateOnly(cycle.period_start, i18n.language)} - ${formatDateOnly(cycle.period_end, i18n.language)} · ${cycle.siteName ?? t("cycles.wholeOrganization")}`} wide>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
        <Button variant="ghost" size="sm" onClick={() => navigate("/payroll")}>{t("nav.back")}</Button>
        <StatusBadge status={STATUS_BADGE[cycle.status]}>{t(`status.${cycle.status}`)}{cycle.cycle_version > 0 ? ` · v${cycle.cycle_version}` : ""}</StatusBadge>
        {cycle.published_version ? <StatusBadge status="active">{t("cycle.published", { version: cycle.published_version })}</StatusBadge> : null}
        {cycle.policy_snapshot?.statutoryMeta?.mode === "custom" ? <StatusBadge status="pending">{t("cycle.customRules")}</StatusBadge> : null}
        {editable && can.edit ? <Button size="sm" variant="ghost" loading={busy === "recalc"} onClick={() => run("recalc", () => PayrollCycleRepository.recalculate(cycleId, cycle.row_version))}>{t("cycle.recalculate")}</Button> : null}
        {actions.filter((a) => a.show).map((a) => (
          <Button key={a.key} size="sm" variant={a.variant ?? "primary"} onClick={() => { setAction(a.key); setReason(""); setAcknowledge(false); }}>{t(`actions.${a.key}`)}</Button>
        ))}
        {cycle.status === "locked" && can.publish ? (
          <Button size="sm" variant={cycle.published_version ? "ghost" : "primary"} loading={busy === "publish"} onClick={() => run("publish", () => PayrollCycleRepository.publish(cycleId, !cycle.published_version))}>
            {cycle.published_version ? t("actions.unpublish") : t("actions.publish")}
          </Button>
        ) : null}
      </div>
      {cycle.status === "locked" && can.publish && !selfService ? (
        <HintText small>{t("cycle.selfServiceOff")} <Link to="/payroll/settings">{t("cycle.openSettings")}</Link></HintText>
      ) : null}
      {cycle.reopen_reason && cycle.status === "reopened" ? <HintText small>{t("cycle.reopenedBecause", { reason: cycle.reopen_reason })}</HintText> : null}
      <ErrorText>{error}</ErrorText>
      {notice ? <SuccessText>{notice}</SuccessText> : null}

      {checks && (checks.errors.length > 0 || checks.warnings.length > 0) && cycle.status !== "cancelled" ? (
        <Card title={t("checks.title")}>
          {checks.errors.map((item, i) => <div key={`e${i}`} style={{ color: "var(--status-danger-text)", fontSize: "var(--font-sm)" }}>✕ {t(`checks.${item.code}`, { defaultValue: item.code })}{item.fullName ? `: ${item.fullName}` : ""}</div>)}
          {checks.warnings.map((item, i) => <div key={`w${i}`} style={{ color: "var(--status-warning-text)", fontSize: "var(--font-sm)" }}>! {t(`checks.${item.code}`, { defaultValue: item.code })}{item.fullName ? `: ${item.fullName}` : ""}</div>)}
        </Card>
      ) : null}

      <Card title={t("cycle.people", { count: employees.length })} subtitle={currencies.length > 1 ? t("cycle.manyCurrencies") : undefined}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "flex-end", marginBottom: "var(--space-2)" }}>
          <div style={{ flex: "1 1 14rem" }}>
            <Input label={t("cycle.search")} name="cycleSearch" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
          <div style={{ minWidth: 150 }}>
            <Select label={t("cycle.sortBy")} name="cycleSort" value={sortBy} onChange={(event) => setSortBy(event.target.value as "name" | "net" | "code")}
              options={(["name", "code", "net"] as const).map((key) => ({ value: key, label: t(`cycle.sort.${key}`) }))} />
          </div>
          {canBulk ? (
            <>
              <Button size="sm" variant="ghost" loading={busy === "copy"} onClick={async () => {
                setNotice("");
                setBusy("copy");
                const result = await PayrollCycleRepository.copyVariables(cycleId);
                setBusy("");
                if (result.error || !result.data) setError(payrollError(result.error, t));
                else setNotice(t("cycle.copied", { copied: result.data.copied, skipped: result.data.skipped }));
                await load();
              }}>{t("cycle.copyVariables")}</Button>
              <Button size="sm" variant="ghost" onClick={() => setChosen(chosen.length === shown.length ? [] : shown.map((e) => e.id))}>
                {chosen.length === shown.length && shown.length > 0 ? t("cycle.chooseNone") : t("cycle.chooseAll")}
              </Button>
              <Button size="sm" disabled={chosen.length === 0} onClick={() => setBulk({ componentId: variableComponents[0]?.id ?? "", amount: "", notes: "" })}>
                {t("cycle.addToChosen", { count: chosen.length })}
              </Button>
            </>
          ) : null}
        </div>
        <Table columns={canBulk ? [{ key: "choose", header: "", render: (e: CycleEmployee) => (
            <input type="checkbox" aria-label={e.full_name} checked={chosen.includes(e.id)} onClick={(event) => event.stopPropagation()} onChange={() => toggle(e.id)} />
          ) }, ...columns] : columns} data={shown} getRowId={(e) => e.id} emptyMessage={t("cycle.empty")} onRowClick={(e) => setOpen(e)} />
      </Card>

      {suggestions.length > 0 ? (
        <Card title={t("suggestions.title")} subtitle={t("suggestions.hint")}>
          {suggestions.map((s) => (
            <div key={`${s.cycleEmployeeId}-${s.kind}`} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--space-2)", padding: "var(--space-2) 0", borderBottom: "1px solid var(--border-light)" }}>
              <span style={{ flex: "1 1 14rem" }}>
                <strong>{s.fullName}</strong> · {t(`suggestions.${s.kind}`, { quantity: Math.round(s.quantity * 100) / 100 })} · {money(s.amount)} {s.currency}
                {s.changedSinceAccepted ? <StatusBadge status="pending">{t("suggestions.changed")}</StatusBadge> : null}
              </span>
              {s.accepted ? <StatusBadge status="active">{t("suggestions.accepted")}</StatusBadge> : (
                <Button size="xs" onClick={() => setAccepting({ s, componentId: variableComponents.find((c) => (s.kind === "overtime_minutes" ? c.category === "earning" : c.category === "deduction"))?.id ?? "", amount: String(Math.round(s.amount * 100) / 100) })}>
                  {t("suggestions.review")}
                </Button>
              )}
            </div>
          ))}
        </Card>
      ) : null}

      <Card title={t("reports.title")} subtitle={t("reports.hint")}>
        <div style={{ maxWidth: 320, marginBottom: "var(--space-2)" }}>
          <Select label={t("exports.scope")} name="exportScope" value={exportScope} onChange={(event) => setExportScope(event.target.value)}
            options={[
              { value: "all", label: t("exports.scopeAll") },
              ...exportSites.map((id) => ({ value: `site:${id}`, label: siteNames[id] ?? id })),
              ...(chosen.length ? [{ value: "chosen", label: t("exports.scopeChosen", { count: chosen.length }) }] : []),
            ]} />
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
          {can.exportPayslips && (cycle.status === "approved" || cycle.status === "locked") ? (
            <Button size="sm" variant="ghost" loading={busy === "bulk-zip"} disabled={working} onClick={async () => {
              setBusy("bulk-zip");
              setError("");
              const result = await PayrollCycleRepository.startExportJob(cycleId, exportSiteUserIds());
              setBusy("");
              if (result.error) setError(payrollError(result.error, t));
              await loadJobs();
            }}>{t("reports.payslip")} · ZIP</Button>
          ) : can.exportPayslips ? <Button size="sm" variant="ghost" loading={busy === "payslip-pdf"} onClick={() => exportReport("payslip", "pdf")}>{t("reports.payslip")} · PDF</Button> : null}
          {can.exportSummary ? <Button size="sm" variant="ghost" loading={busy === "summary-pdf"} onClick={() => exportReport("summary", "pdf")}>{t("reports.summary")} · PDF</Button> : null}
          {can.exportSummary ? <Button size="sm" variant="ghost" loading={busy === "summary-xlsx"} onClick={() => exportReport("summary", "xlsx")}>{t("reports.summary")} · Excel</Button> : null}
          {can.exportCombined ? <Button size="sm" variant="ghost" loading={busy === "combined-pdf"} onClick={() => exportReport("combined", "pdf")}>{t("reports.combined")} · PDF</Button> : null}
          {can.exportCombined ? <Button size="sm" variant="ghost" loading={busy === "combined-xlsx"} onClick={() => exportReport("combined", "xlsx")}>{t("reports.combined")} · Excel</Button> : null}
        </div>
        {cycle.status !== "approved" && cycle.status !== "locked" ? <HintText small>{t("reports.draftNote")}</HintText> : <HintText small>{t("exports.hint")}</HintText>}
        {jobs.length > 0 ? (
          <div style={{ marginTop: "var(--space-2)" }}>
            {jobs.slice(0, 5).map((job) => (
              <div key={job.id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--space-2)", padding: "6px 0", borderTop: "1px solid var(--border-light)", fontSize: "var(--font-sm)" }}>
                <span style={{ flex: "1 1 14rem" }}>
                  {formatDateOnly(job.createdAt, i18n.language)} · v{job.cycleVersion} · {t(`exports.status.${job.status}`, { done: job.done, total: job.total })}
                  {job.status === "failed" && job.error ? <span style={{ color: "var(--status-danger-text)" }}> · {job.error}</span> : null}
                  {job.status === "done" && job.expiresAt ? <span style={{ color: "var(--text-secondary)" }}> · {t("exports.until", { date: formatDateOnly(job.expiresAt, i18n.language) })}</span> : null}
                </span>
                {job.status === "running" || job.status === "queued" ? (
                  <progress max={Math.max(job.total, 1)} value={job.done} style={{ width: 120 }} aria-label={t("exports.progress")} />
                ) : null}
                {job.status === "done" ? (
                  <Button size="xs" loading={busy === `dl-${job.id}`} onClick={async () => {
                    setBusy(`dl-${job.id}`);
                    const result = await PayrollCycleRepository.downloadExportJob(job.id);
                    setBusy("");
                    if (result.error || !result.data) {
                      setError(payrollError(result.error, t));
                      return;
                    }
                    window.location.assign(result.data.url);
                  }}>{t("exports.download")}</Button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </Card>

      {editable && can.import ? (
        <Card title={t("import.title")} subtitle={t("import.hint")}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "center" }}>
            <Button size="sm" variant="ghost" onClick={template}>{t("import.template")}</Button>
            <input type="file" accept=".csv,text/csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ""; }} />
          </div>
        </Card>
      ) : null}

      {/* one line for the chosen people (all or nothing) */}
      <Modal isOpen={bulk !== null} onClose={() => setBulk(null)} title={t("cycle.addToChosen", { count: chosen.length })}
        footer={<Button loading={busy === "bulk"} disabled={!bulk?.componentId || bulk.amount.trim() === ""} onClick={async () => {
          if (!bulk) return;
          const amount = amountOf(bulk.amount);
          if (amount === null) return;
          const okBulk = await run("bulk", () => PayrollCycleRepository.addLineBulk(cycleId, chosen, bulk.componentId, amount, bulk.notes.trim() || null));
          if (okBulk) {
            setBulk(null);
            setChosen([]);
          }
        }}>{t("lines.save")}</Button>}>
        {bulk ? (
          <div style={{ display: "grid", gap: "var(--space-3)" }}>
            {modalError}
            <Select label={t("lines.component")} name="bulkComponent" value={bulk.componentId} onChange={(event) => setBulk({ ...bulk, componentId: event.target.value })}
              options={variableComponents.map((c) => ({ value: c.id, label: isRtl ? c.name_ar : c.name_en || c.name_ar }))} />
            <Input label={t("lines.amount")} name="bulkAmount" inputMode="decimal" value={bulk.amount} onChange={(event) => setBulk({ ...bulk, amount: event.target.value })} />
            <Input label={t("lines.notes")} name="bulkNotes" value={bulk.notes} onChange={(event) => setBulk({ ...bulk, notes: event.target.value })} />
            <HintText small>{t("cycle.bulkHint")}</HintText>
          </div>
        ) : null}
      </Modal>

      {/* one person's lines */}
      <Modal isOpen={Boolean(open)} onClose={() => setOpen(null)} title={open ? open.full_name : ""} size="lg"
        footer={open && editable && can.enterVariables ? <Button onClick={() => setLine({ id: null, componentId: variableComponents[0]?.id ?? "", amount: "", notes: "", version: null })}>{t("lines.add")}</Button> : undefined}>
        {open ? (
          <div>
            {line || bulk || accepting ? null : modalError}
            {(["earning", "allowance", "deduction", "installment"] as CycleLine["category"][]).map((category) => {
              const lines = open.lines.filter((l) => l.category === category);
              if (lines.length === 0) return null;
              return (
                <div key={category} style={{ marginBottom: "var(--space-3)" }}>
                  <h4 style={{ margin: "0 0 var(--space-1)" }}>{t(`categories.${category}`)}</h4>
                  {lines.map((l) => (
                    <div key={l.id} style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "center", fontSize: "var(--font-sm)", padding: "4px 0", borderBottom: "1px solid var(--border-light)" }}>
                      <span style={{ flex: "1 1 12rem" }}>
                        {isRtl ? l.name_ar : l.name_en || l.name_ar}
                        {!l.include_in_net ? <StatusBadge status="neutral">{t("lines.outsideNet")}</StatusBadge> : null}
                        <span style={{ color: "var(--text-secondary)" }}> · {t(`sources.${l.source}`)}{l.calc_type === "percent" ? ` · ${l.percent}%` : ""}{l.notes ? ` · ${l.notes}` : ""}</span>
                      </span>
                      <strong>{money(l.amount)}</strong>
                      {editable && can.enterVariables && !["fixed", "installment", "statutory", "penalty", "incentive"].includes(l.source) ? (
                        <>
                          <Button size="xs" variant="ghost" onClick={() => setLine({ id: l.id, componentId: l.component_id ?? "", amount: String(l.raw_amount), notes: l.notes ?? "", version: l.row_version })}>{t("lines.edit")}</Button>
                          <Button size="xs" variant="danger" onClick={() => run(`del-${l.id}`, () => PayrollCycleRepository.deleteLine(l.id, l.row_version))}>{t("lines.delete")}</Button>
                        </>
                      ) : null}
                    </div>
                  ))}
                </div>
              );
            })}
            <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, borderTop: "2px solid var(--border-light)", paddingTop: "var(--space-2)" }}>
              <span>{t("doc.net")}</span><span>{money(open.net_salary)} {open.currency}</span>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal isOpen={Boolean(line)} onClose={() => setLine(null)} title={line?.id ? t("lines.edit") : t("lines.add")}
        footer={<Button loading={busy === "line"} onClick={async () => {
          if (!line || !open) return;
          if (!line.id && !line.componentId) { setError(t("errors.chooseItem")); return; }
          const amount = amountOf(line.amount);
          if (amount === null) return;
          const ok = await run("line", () => PayrollCycleRepository.saveLine(open.id, line.id, line.id ? null : line.componentId, amount, line.notes.trim() || null, line.version));
          if (ok) setLine(null);
        }}>{t("lines.save")}</Button>}>
        {line ? (
          <>
            {modalError}
            {!line.id ? <Select label={t("lines.component")} name="lineComponent" value={line.componentId} onChange={(event) => setLine({ ...line, componentId: event.target.value })}
              options={variableComponents.map((c) => ({ value: c.id, label: `${isRtl ? c.name_ar : c.name_en || c.name_ar} · ${t(`categories.${c.category}`)}` }))} /> : null}
            <Input label={t("lines.amount")} name="lineAmount" inputMode="decimal" value={line.amount} onChange={(event) => setLine({ ...line, amount: event.target.value })} />
            <Input label={t("lines.notes")} name="lineNotes" value={line.notes} onChange={(event) => setLine({ ...line, notes: event.target.value })} />
            {variableComponents.length === 0 ? <HintText small>{t("lines.noVariableComponents")}</HintText> : null}
          </>
        ) : null}
      </Modal>

      <Modal isOpen={Boolean(accepting)} onClose={() => setAccepting(null)} title={t("suggestions.review")}
        footer={<Button loading={busy === "accept"} onClick={async () => {
          if (!accepting) return;
          if (!accepting.componentId) { setError(t("errors.chooseItem")); return; }
          const amount = amountOf(accepting.amount);
          if (amount === null) return;
          const ok = await run("accept", () => PayrollCycleRepository.saveLine(accepting.s.cycleEmployeeId, null, accepting.componentId, amount, null, null, "attendance_suggestion",
            { kind: accepting.s.kind, quantity: accepting.s.quantity, unit: accepting.s.unit, suggested: accepting.s.amount }));
          if (ok) setAccepting(null);
        }}>{t("suggestions.accept")}</Button>}>
        {accepting ? (
          <>
            {modalError}
            <HintText small>{accepting.s.fullName} · {t(`suggestions.${accepting.s.kind}`, { quantity: Math.round(accepting.s.quantity * 100) / 100 })}</HintText>
            <Select label={t("lines.component")} name="acceptComponent" value={accepting.componentId} onChange={(event) => setAccepting({ ...accepting, componentId: event.target.value })}
              options={variableComponents.map((c) => ({ value: c.id, label: `${isRtl ? c.name_ar : c.name_en || c.name_ar} · ${t(`categories.${c.category}`)}` }))} />
            <Input label={t("lines.amount")} name="acceptAmount" inputMode="decimal" value={accepting.amount} onChange={(event) => setAccepting({ ...accepting, amount: event.target.value })} />
          </>
        ) : null}
      </Modal>

      <Modal isOpen={Boolean(action)} onClose={() => setAction(null)} title={action ? t(`actions.${action}`) : ""}
        footer={<Button variant={action === "cancel" ? "danger" : "primary"} loading={busy === action} onClick={doAction}>{action ? t(`actions.${action}`) : ""}</Button>}>
        {action ? <HintText small>{t(`actionHints.${action}`)}</HintText> : null}
        {action === "submit" && checks && checks.warnings.length > 0 ? (
          <label style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", margin: "var(--space-2) 0" }}>
            <input type="checkbox" checked={acknowledge} onChange={(event) => setAcknowledge(event.target.checked)} />
            {t("checks.acknowledge", { count: checks.warnings.length })}
          </label>
        ) : null}
        {action && NEEDS_REASON.includes(action) ? <Textarea label={t("actions.reason")} name="cycleReason" value={reason} onChange={(event) => setReason(event.target.value)} /> : null}
      </Modal>

      <Modal isOpen={Boolean(importResult)} onClose={() => setImportResult(null)} title={t("import.title")}
        footer={importResult && importResult.errors.length === 0 && !importResult.saved ? (
          <Button loading={busy === "import"} onClick={async () => {
            if (!importResult) return;
            setBusy("import");
            const result = await PayrollCycleRepository.importLines(cycleId, importResult.rows, importResult.fileName, false);
            setBusy("");
            if (result.error || !result.data?.saved) setError(payrollError(result.error, t));
            setImportResult(null);
            await load();
          }}>{t("import.confirm", { count: importResult.valid })}</Button>
        ) : undefined}>
        {importResult ? (
          importResult.errors.length === 0 ? <HintText>{t("import.ready", { count: importResult.valid })}</HintText> : (
            <>
              <HintText small>{t("import.hasErrors")}</HintText>
              {importResult.errors.map((e, i) => <div key={i} style={{ fontSize: "var(--font-sm)", color: "var(--status-danger-text)" }}>{t("import.rowError", { row: e.row + 1, error: t(`import.codes.${e.code}`, { defaultValue: e.code }) })}</div>)}
            </>
          )
        ) : null}
      </Modal>
    </PageShell>
  );
}
