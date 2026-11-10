import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";
import PayrollCycleRepository, { type CycleSummary } from "../../core/repositories/PayrollCycleRepository";
import SiteRepository from "../../core/repositories/SiteRepository";
import { formatDateOnly } from "../../core/utils/formatDate";
import PageShell from "../../components/common/PageShell";
import PageBanner from "../../components/common/PageBanner";
import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Table, { type TableColumn } from "../../components/common/Table";
import StatusBadge from "../../components/common/StatusBadge";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import illustration from "../../assets/illustrations/timesheets.svg";
import PayrollStepsCard from "./PayrollStepsCard";
import { STATUS_BADGE, defaultPeriod, money, payrollError } from "./payrollUi";
import usePayrollDigits from "./usePayrollDigits";

// 2026-11-08: the payroll home - the cycles in the caller's scope, a new cycle, and the way to
// profiles, settings and the payslip requests. What each person may do is decided by the server.
export default function PayrollHomePage() {
  const { t, i18n } = useTranslation("payroll");
  usePayrollDigits();
  const { hasPermission, profile } = useAuth();
  const navigate = useNavigate();
  const [cycles, setCycles] = useState<CycleSummary[] | null>(null);
  const [sites, setSites] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [siteId, setSiteId] = useState("");
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [skipped, setSkipped] = useState<{ fullName: string; reason: string }[]>([]);
  const owner = Boolean(profile?.isOwner);
  const can = (key: string) => owner || hasPermission(key);

  const load = useCallback(async () => {
    const [list, settings, siteList] = await Promise.all([PayrollCycleRepository.listCycles(), PayrollCycleRepository.getSettings(), SiteRepository.listSites()]);
    if (list.error) setError(payrollError(list.error, t));
    setCycles(list.data ?? []);
    const period = defaultPeriod(settings.data?.period_start_day ?? 1);
    setStart((value) => value || period.start);
    setEnd((value) => value || period.end);
    setSites((siteList.data ?? []).map((site) => ({ id: site.id, name: site.name })));
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setCreating(true);
    setError("");
    setSkipped([]);
    const result = await PayrollCycleRepository.createCycle(start, end, siteId || null, title.trim() || null);
    setCreating(false);
    if (result.error || !result.data) {
      setError(payrollError(result.error, t));
      return;
    }
    setSkipped(result.data.skipped ?? []);
    navigate(`/payroll/cycles/${result.data.cycleId}`);
  };

  const columns: TableColumn<CycleSummary>[] = [
    { key: "title", header: t("cycles.title"), render: (row) => <strong>{row.title}</strong> },
    { key: "period", header: t("cycles.period"), render: (row) => `${formatDateOnly(row.periodStart, i18n.language)} - ${formatDateOnly(row.periodEnd, i18n.language)}` },
    { key: "scope", header: t("cycles.scope"), render: (row) => row.siteName ?? t("cycles.wholeOrganization") },
    { key: "status", header: t("cycles.status"), render: (row) => <StatusBadge status={STATUS_BADGE[row.status]}>{t(`status.${row.status}`)}{row.cycleVersion > 0 ? ` · v${row.cycleVersion}` : ""}</StatusBadge> },
    { key: "employees", header: t("cycles.employees"), render: (row) => row.employees },
    { key: "net", header: t("cycles.net"), render: (row) => row.totals.map((total) => `${money(total.net)} ${total.currency}`).join(" · ") || "-" },
  ];

  return (
    <PageShell title="" wide>
      <PageBanner pageId="payroll" illustration={illustration} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
        {can("payroll.manage_profiles") || can("payroll.view") ? <Button variant="ghost" onClick={() => navigate("/payroll/profiles")}>{t("nav.profiles")}</Button> : null}
        {can("payroll.export_payslips") ? <Button variant="ghost" onClick={() => navigate("/payroll/requests")}>{t("nav.requests")}</Button> : null}
        {can("payroll.manage_settings") ? <Button variant="ghost" onClick={() => navigate("/payroll/settings")}>{t("nav.settings")}</Button> : null}
      </div>

      <PayrollStepsCard canSettings={can("payroll.manage_settings")} canProfiles={can("payroll.manage_profiles") || can("payroll.view")} cycles={cycles?.length ?? 0} />

      {can("payroll.edit_draft") ? (
        <Card title={t("cycles.newTitle")} subtitle={t("cycles.newHint")}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))", gap: "var(--space-3)" }}>
            <Input label={t("cycles.start")} name="cycleStart" type="date" value={start} onChange={(event) => setStart(event.target.value)} />
            <Input label={t("cycles.end")} name="cycleEnd" type="date" value={end} onChange={(event) => setEnd(event.target.value)} />
            <Select label={t("cycles.scope")} name="cycleSite" value={siteId} onChange={(event) => setSiteId(event.target.value)}
              options={[{ value: "", label: t("cycles.wholeOrganization") }, ...sites.map((site) => ({ value: site.id, label: site.name }))]} />
            <Input label={t("cycles.titleOptional")} name="cycleTitle" value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>
          <Button onClick={create} loading={creating} disabled={!start || !end}>{t("cycles.create")}</Button>
          {skipped.length > 0 ? <HintText small>{t("cycles.skipped", { names: skipped.map((s) => s.fullName).join(", ") })}</HintText> : null}
        </Card>
      ) : null}

      <ErrorText>{error}</ErrorText>
      <Card title={t("cycles.listTitle")}>
        <Table columns={columns} data={cycles ?? []} getRowId={(row) => row.id} loading={cycles === null} emptyMessage={t("cycles.empty")}
          onRowClick={(row) => navigate(`/payroll/cycles/${row.id}`)} />
      </Card>
    </PageShell>
  );
}
