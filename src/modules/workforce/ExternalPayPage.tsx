import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import ExternalLaborRepository, {
  RATE_UNITS,
  type ExternalSettings,
  type ExternalWorkerRates,
  type PolicyItem,
  type RateUnit,
  type RunSummary,
} from "../../core/repositories/ExternalLaborRepository";
import SiteRepository from "../../core/repositories/SiteRepository";
import { formatDateOnly } from "../../core/utils/formatDate";
import PageShell from "../../components/common/PageShell";
import PageBanner from "../../components/common/PageBanner";
import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Modal from "../../components/common/Modal";
import Table, { type TableColumn } from "../../components/common/Table";
import StatusBadge from "../../components/common/StatusBadge";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import illustration from "../../assets/illustrations/timesheets.svg";
import { defaultPeriod, money } from "../payroll/payrollUi";
import { externalPayError } from "./externalPayUi";

type View = "runs" | "rates" | "policy";

// 2026-11-08 B-07: external labour pay - pay runs, each worker's rate (amount, currency, unit),
// and the organisation's policy and day-rate rule. Separate from employees and payroll.
export default function ExternalPayPage() {
  const { t, i18n } = useTranslation("externalPay");
  const navigate = useNavigate();
  const [view, setView] = useState<View>("runs");
  const [error, setError] = useState("");
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [rates, setRates] = useState<ExternalWorkerRates[] | null>(null);
  const [policy, setPolicy] = useState<PolicyItem[] | null>(null);
  const [settings, setSettings] = useState<ExternalSettings | null>(null);
  const [sites, setSites] = useState<{ id: string; name: string }[]>([]);
  const [period, setPeriod] = useState(() => defaultPeriod(1));
  const [siteId, setSiteId] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [skipped, setSkipped] = useState<{ name: string; reason: string }[]>([]);
  const [rateFor, setRateFor] = useState<ExternalWorkerRates | null>(null);
  const [rateDraft, setRateDraft] = useState({ amount: "", currency: "EGP", unit: "DAILY" as RateUnit, from: new Date().toISOString().slice(0, 10) });
  const [item, setItem] = useState<PolicyItem | null>(null);
  const [divisor, setDivisor] = useState({ basis: "fixed", value: "30" });

  const load = useCallback(async () => {
    const [runList, rateList, policyList, settingsResult, siteList] = await Promise.all([
      ExternalLaborRepository.listRuns(),
      ExternalLaborRepository.listRates(),
      ExternalLaborRepository.listPolicy(),
      ExternalLaborRepository.getSettings(),
      SiteRepository.listSites(),
    ]);
    const firstError = runList.error ?? rateList.error;
    if (firstError) setError(externalPayError(firstError, t));
    setRuns(runList.data ?? []);
    setRates(rateList.data ?? []);
    setPolicy(policyList.data ?? []);
    if (settingsResult.data) {
      setSettings(settingsResult.data);
      setDivisor({ basis: settingsResult.data.dayRateBasis, value: String(settingsResult.data.fixedDivisor) });
    }
    setSites((siteList.data ?? []).map((site) => ({ id: site.id, name: site.name })));
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<{ error: string | null }>, after?: () => void) => {
    setBusy(true);
    setError("");
    const result = await action();
    setBusy(false);
    if (result.error) {
      setError(externalPayError(result.error, t));
      return false;
    }
    after?.();
    await load();
    return true;
  };

  const createRun = async () => {
    setBusy(true);
    setError("");
    setSkipped([]);
    const result = await ExternalLaborRepository.createRun(period.start, period.end, siteId || null, title.trim() || null);
    setBusy(false);
    if (result.error || !result.data) {
      setError(externalPayError(result.error, t));
      return;
    }
    if (result.data.skipped.length && result.data.added === 0) {
      setSkipped(result.data.skipped);
      await load();
      return;
    }
    navigate(`/workers/pay/${result.data.runId}`, { state: { skipped: result.data.skipped } });
  };

  const canManageAnyRate = (rates ?? []).some((row) => row.canManage);
  const runColumns: TableColumn<RunSummary>[] = [
    { key: "title", header: t("runs.title"), render: (row) => <strong>{row.title}</strong> },
    { key: "period", header: t("runs.period"), render: (row) => `${formatDateOnly(row.periodStart, i18n.language)} - ${formatDateOnly(row.periodEnd, i18n.language)}` },
    { key: "site", header: t("runs.site"), render: (row) => row.siteName ?? t("runs.allSites") },
    { key: "status", header: t("runs.status"), render: (row) => <StatusBadge status={row.status === "approved" ? "active" : "pending"}>{t(`status.${row.status}`)} · v{row.runVersion}</StatusBadge> },
    { key: "workers", header: t("runs.workers"), render: (row) => row.workers },
  ];
  const rateColumns: TableColumn<ExternalWorkerRates>[] = [
    { key: "name", header: t("rates.worker"), render: (row) => <span><strong>{row.name}</strong> <span style={{ color: "var(--text-secondary)" }}>#{row.workerNumber}</span></span> },
    { key: "contractor", header: t("rates.contractor"), render: (row) => row.contractorName ?? "-" },
    { key: "site", header: t("rates.site"), render: (row) => row.siteName ?? "-" },
    { key: "rate", header: t("rates.current"), render: (row) => (row.current ? `${money(row.current.amount)} ${row.current.currency} / ${t(`unit.${row.current.unit}`)}` : <span style={{ color: "var(--color-warning, #b45309)" }}>{t("rates.none")}</span>) },
    { key: "from", header: t("rates.since"), render: (row) => (row.current ? formatDateOnly(row.current.effectiveFrom, i18n.language) : "-") },
    {
      key: "action",
      header: "",
      render: (row) =>
        row.canManage ? (
          <Button size="sm" variant="ghost" onClick={() => {
            setRateFor(row);
            setRateDraft({ amount: row.current ? String(row.current.amount) : "", currency: row.current?.currency ?? "EGP", unit: row.current?.unit ?? "DAILY", from: new Date().toISOString().slice(0, 10) });
          }}>
            {t("rates.set")}
          </Button>
        ) : null,
    },
  ];
  const policyColumns: TableColumn<PolicyItem>[] = [
    { key: "name", header: t("policy.name"), render: (row) => <strong>{row.name}</strong> },
    { key: "kind", header: t("policy.kind"), render: (row) => t(`adjustment.${row.kind}`) },
    { key: "value", header: t("policy.value"), render: (row) => (row.calc === "percent" ? `${row.value}% ${t("policy.ofGross")}` : `${money(row.value)} ${row.currency}`) },
    { key: "active", header: t("policy.active"), render: (row) => (row.isActive ? t("policy.yes") : t("policy.no")) },
    { key: "edit", header: "", render: (row) => (settings?.canManagePolicy ? <Button size="sm" variant="ghost" onClick={() => setItem({ ...row })}>{t("policy.edit")}</Button> : null) },
  ];

  return (
    <PageShell title="" wide>
      <PageBanner pageId="externalPay" illustration={illustration} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", marginBottom: "var(--space-3)" }} role="tablist">
        {(["runs", "rates", "policy"] as View[]).map((key) => (
          <Button key={key} variant={view === key ? "primary" : "ghost"} onClick={() => setView(key)} aria-selected={view === key} role="tab">
            {t(`views.${key}`)}
          </Button>
        ))}
        <Button variant="ghost" onClick={() => navigate("/workers")}>{t("views.workers")}</Button>
      </div>
      <ErrorText>{error}</ErrorText>

      {view === "runs" ? (
        <>
          {canManageAnyRate ? (
            <Card title={t("runs.newTitle")} subtitle={t("runs.newHint")}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))", gap: "var(--space-3)" }}>
                <Input label={t("runs.start")} name="runStart" type="date" value={period.start} onChange={(event) => setPeriod({ ...period, start: event.target.value })} />
                <Input label={t("runs.end")} name="runEnd" type="date" value={period.end} onChange={(event) => setPeriod({ ...period, end: event.target.value })} />
                <Select label={t("runs.site")} name="runSite" value={siteId} onChange={(event) => setSiteId(event.target.value)}
                  options={[{ value: "", label: t("runs.allSites") }, ...sites.map((site) => ({ value: site.id, label: site.name }))]} />
                <Input label={t("runs.titleOptional")} name="runTitle" value={title} onChange={(event) => setTitle(event.target.value)} />
              </div>
              <Button onClick={createRun} loading={busy} disabled={!period.start || !period.end}>{t("runs.create")}</Button>
              {skipped.length ? <HintText small>{t("runs.skipped", { names: skipped.map((s) => `${s.name} (${t(`skipReason.${s.reason}`)})`).join(", ") })}</HintText> : null}
            </Card>
          ) : null}
          <Card title={t("runs.listTitle")}>
            <Table columns={runColumns} data={runs ?? []} getRowId={(row) => row.id} loading={runs === null} emptyMessage={t("runs.empty")} onRowClick={(row) => navigate(`/workers/pay/${row.id}`)} />
          </Card>
        </>
      ) : null}

      {view === "rates" ? (
        <Card title={t("rates.title")} subtitle={t("rates.hint")}>
          <Table columns={rateColumns} data={rates ?? []} getRowId={(row) => row.workerId} loading={rates === null} emptyMessage={t("rates.empty")} />
        </Card>
      ) : null}

      {view === "policy" ? (
        <>
          <Card title={t("policy.ruleTitle")} subtitle={t("policy.ruleHint")}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(13rem, 1fr))", gap: "var(--space-3)" }}>
              <Select label={t("policy.basis")} name="dayBasis" value={divisor.basis} disabled={!settings?.canManagePolicy} onChange={(event) => setDivisor({ ...divisor, basis: event.target.value })}
                options={["fixed", "calendar", "working"].map((value) => ({ value, label: t(`policy.basisOption.${value}`) }))} />
              {divisor.basis === "fixed" ? (
                <Input label={t("policy.divisor")} name="dayDivisor" type="number" value={divisor.value} disabled={!settings?.canManagePolicy} onChange={(event) => setDivisor({ ...divisor, value: event.target.value })} />
              ) : null}
            </div>
            {settings?.canManagePolicy ? (
              <Button loading={busy} onClick={() => run(() => ExternalLaborRepository.saveSettings(divisor.basis, Number(divisor.value) || 30))}>{t("policy.saveRule")}</Button>
            ) : null}
            <HintText small>{t("policy.ruleNote")}</HintText>
          </Card>
          <Card title={t("policy.itemsTitle")} subtitle={t("policy.itemsHint")}>
            {settings?.canManagePolicy ? (
              <Button variant="ghost" onClick={() => setItem({ name: "", kind: "deduction", calc: "percent", value: 0, currency: null, isActive: true })}>{t("policy.add")}</Button>
            ) : null}
            <Table columns={policyColumns} data={policy ?? []} getRowId={(row) => row.id ?? row.name} loading={policy === null} emptyMessage={t("policy.empty")} />
          </Card>
        </>
      ) : null}

      <Modal isOpen={rateFor !== null} onClose={() => setRateFor(null)} title={t("rates.setTitle", { name: rateFor?.name ?? "" })}
        footer={<Button loading={busy} disabled={!(Number(rateDraft.amount) > 0)} onClick={() => run(() => ExternalLaborRepository.setRate(rateFor!.workerId, Number(rateDraft.amount), rateDraft.currency, rateDraft.unit, rateDraft.from), () => setRateFor(null))}>{t("rates.save")}</Button>}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))", gap: "var(--space-3)" }}>
          <Input label={t("rates.amount")} name="rateAmount" type="number" value={rateDraft.amount} onChange={(event) => setRateDraft({ ...rateDraft, amount: event.target.value })} />
          <Input label={t("rates.currency")} name="rateCurrency" value={rateDraft.currency} onChange={(event) => setRateDraft({ ...rateDraft, currency: event.target.value.toUpperCase().slice(0, 3) })} />
          <Select label={t("rates.unit")} name="rateUnit" value={rateDraft.unit} onChange={(event) => setRateDraft({ ...rateDraft, unit: event.target.value as RateUnit })}
            options={RATE_UNITS.map((unit) => ({ value: unit, label: t(`unit.${unit}`) }))} />
          <Input label={t("rates.effectiveFrom")} name="rateFrom" type="date" value={rateDraft.from} onChange={(event) => setRateDraft({ ...rateDraft, from: event.target.value })} />
        </div>
        <HintText small>{t("rates.noConversion")}</HintText>
        {rateFor && rateFor.history.length > 0 ? (
          <ul style={{ margin: 0, paddingInlineStart: "1.2rem", fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
            {rateFor.history.map((rate) => (
              <li key={rate.effectiveFrom}>{`${money(rate.amount)} ${rate.currency} / ${t(`unit.${rate.unit}`)} · ${formatDateOnly(rate.effectiveFrom, i18n.language)}${rate.effectiveTo ? ` - ${formatDateOnly(rate.effectiveTo, i18n.language)}` : ""}`}</li>
            ))}
          </ul>
        ) : null}
      </Modal>

      <Modal isOpen={item !== null} onClose={() => setItem(null)} title={item?.id ? t("policy.edit") : t("policy.add")}
        footer={<Button loading={busy} disabled={!item?.name.trim() || !(Number(item?.value) > 0)} onClick={() => item && run(() => ExternalLaborRepository.savePolicyItem({ ...item, value: Number(item.value) }), () => setItem(null))}>{t("policy.save")}</Button>}>
        {item ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))", gap: "var(--space-3)" }}>
            <Input label={t("policy.name")} name="itemName" value={item.name} onChange={(event) => setItem({ ...item, name: event.target.value })} />
            <Select label={t("policy.kind")} name="itemKind" value={item.kind} onChange={(event) => setItem({ ...item, kind: event.target.value as PolicyItem["kind"] })}
              options={[{ value: "deduction", label: t("adjustment.deduction") }, { value: "addition", label: t("adjustment.addition") }]} />
            <Select label={t("policy.calc")} name="itemCalc" value={item.calc} onChange={(event) => setItem({ ...item, calc: event.target.value as PolicyItem["calc"], currency: event.target.value === "fixed" ? item.currency ?? "EGP" : null })}
              options={[{ value: "percent", label: t("policy.percent") }, { value: "fixed", label: t("policy.fixed") }]} />
            <Input label={item.calc === "percent" ? t("policy.percentValue") : t("policy.amount")} name="itemValue" type="number" value={String(item.value || "")} onChange={(event) => setItem({ ...item, value: Number(event.target.value) })} />
            {item.calc === "fixed" ? (
              <Input label={t("rates.currency")} name="itemCurrency" value={item.currency ?? ""} onChange={(event) => setItem({ ...item, currency: event.target.value.toUpperCase().slice(0, 3) })} />
            ) : null}
            <Select label={t("policy.active")} name="itemActive" value={item.isActive ? "1" : "0"} onChange={(event) => setItem({ ...item, isActive: event.target.value === "1" })}
              options={[{ value: "1", label: t("policy.yes") }, { value: "0", label: t("policy.no") }]} />
          </div>
        ) : null}
      </Modal>
    </PageShell>
  );
}
