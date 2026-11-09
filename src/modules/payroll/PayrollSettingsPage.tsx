import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import PayrollCycleRepository, { type PayrollComponent, type PayrollSettings } from "../../core/repositories/PayrollCycleRepository";
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
import PayrollStatutoryCard from "./PayrollStatutoryCard";
import { payrollError } from "./payrollUi";

type Draft = Partial<PayrollComponent> & { name_ar: string };
const EMPTY: Draft = { name_ar: "", name_en: "", category: "earning", source: "variable", calc_type: "amount", include_in_net: true, include_in_combined: false, prorate: false, is_basic: false, sort_order: 100, is_active: true, taxable: true, insurable: false, applies_to_all: false, default_amount: null };

// 2026-11-08: payroll settings (period, proration, attendance rates, currency, checks, publishing,
// report wording) and the components the organisation defines - no country tax tables: taxes and
// insurance are components entered as an amount or a percentage of a chosen base.
export default function PayrollSettingsPage() {
  const { t, i18n } = useTranslation("payroll");
  const navigate = useNavigate();
  const isRtl = i18n.dir() === "rtl";
  const [settings, setSettings] = useState<PayrollSettings | null>(null);
  const [components, setComponents] = useState<PayrollComponent[]>([]);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState("");
  const [draft, setDraft] = useState<{ id: string | null; value: Draft } | null>(null);

  const load = useCallback(async () => {
    const [s, c] = await Promise.all([PayrollCycleRepository.getSettings(), PayrollCycleRepository.listComponents()]);
    if (s.error) setError(payrollError(s.error, t));
    setSettings(s.data);
    setComponents(c.data ?? []);
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!settings) return <PageShell title={t("nav.settings")}><ErrorText>{error}</ErrorText></PageShell>;
  const set = <K extends keyof PayrollSettings>(key: K, value: PayrollSettings[K]) => { setSettings({ ...settings, [key]: value }); setSaved(false); };
  const num = (key: keyof PayrollSettings, labelKey: string) => (
    <Input label={t(labelKey)} name={String(key)} type="number" value={String(settings[key] ?? "")} onChange={(event) => set(key, Number(event.target.value) as never)} />
  );
  const check = (key: keyof PayrollSettings, labelKey: string) => (
    <label style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", margin: "var(--space-1) 0" }}>
      <input type="checkbox" checked={Boolean(settings[key])} onChange={(event) => set(key, event.target.checked as never)} /> {t(labelKey)}
    </label>
  );

  const columns: TableColumn<PayrollComponent>[] = [
    { key: "name", header: t("components.name"), render: (c) => <strong>{isRtl ? c.name_ar : c.name_en || c.name_ar}</strong> },
    { key: "category", header: t("components.category"), render: (c) => t(`categories.${c.category}`) },
    { key: "source", header: t("components.source"), render: (c) => t(`components.sources.${c.source}`) },
    { key: "calc", header: t("components.calc"), render: (c) => (c.calc_type === "percent" ? `${c.percent}% · ${t(`components.bases.${c.percent_base}`)}` : t("components.amountType")) },
    { key: "net", header: t("components.inNet"), render: (c) => (c.include_in_net ? t("components.yes") : <StatusBadge status="neutral">{t("lines.outsideNet")}</StatusBadge>) },
    { key: "flags", header: "", render: (c) => [c.is_basic ? t("components.basic") : null, c.prorate ? t("components.prorated") : null, c.include_in_combined ? t("components.inCombined") : null, !c.is_active ? t("components.inactive") : null].filter(Boolean).join(" · ") },
  ];

  const saveComponent = async () => {
    if (!draft) return;
    if (!draft.value.name_ar.trim()) { setError(t("components.nameRequired")); return; }
    setBusy("component");
    setError("");
    const result = await PayrollCycleRepository.saveComponent(draft.id, draft.value);
    setBusy("");
    if (result.error) { setError(payrollError(result.error, t)); return; }
    setDraft(null);
    await load();
  };
  const d = draft?.value;
  const setD = (patch: Partial<Draft>) => draft && setDraft({ ...draft, value: { ...draft.value, ...patch } });

  return (
    <PageShell title={t("nav.settings")} wide>
      <Button variant="ghost" size="sm" onClick={() => navigate("/payroll")}>{t("nav.back")}</Button>
      <ErrorText>{error}</ErrorText>

      <Card title={t("components.title")} subtitle={t("components.hint")} actions={<Button size="sm" onClick={() => setDraft({ id: null, value: { ...EMPTY } })}>{t("components.add")}</Button>}>
        <Table columns={columns} data={components} getRowId={(c) => c.id} emptyMessage={t("components.empty")}
          onRowClick={(c) => setDraft({ id: c.id, value: { ...c, name_en: c.name_en ?? "" } })} />
      </Card>

      <PayrollStatutoryCard />

      {/* Owner 2026-11-09: what is used most first - components, insurance and taxes; the policies after */}
      <Card title={t("settings.title")}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))", gap: "var(--space-3)" }}>
          {num("period_start_day", "settings.periodStartDay")}
          <Select label={t("settings.proration")} name="proration" value={settings.proration_policy} onChange={(event) => set("proration_policy", event.target.value as PayrollSettings["proration_policy"])}
            options={(["none", "calendar", "working", "fixed"] as const).map((v) => ({ value: v, label: t(`settings.prorations.${v}`) }))} />
          {settings.proration_policy === "fixed" ? num("proration_divisor", "settings.prorationDivisor") : null}
          <Input label={t("settings.currency")} name="currency" value={settings.default_currency} onChange={(event) => set("default_currency", event.target.value.toUpperCase().slice(0, 3))} />
          {num("day_divisor", "settings.dayDivisor")}
          {num("hours_per_day", "settings.hoursPerDay")}
          {num("overtime_multiplier", "settings.overtimeMultiplier")}
          {num("net_change_warning_percent", "settings.netChangeWarning")}
          <Select label={t("settings.reportLanguage")} name="reportLanguage" value={settings.report_language} onChange={(event) => set("report_language", event.target.value as PayrollSettings["report_language"])}
            options={(["bilingual", "ar", "en"] as const).map((v) => ({ value: v, label: t(`settings.languages.${v}`) }))} />
        </div>
        {check("allow_negative_net", "settings.allowNegative")}
        {check("auto_lock_on_approve", "settings.autoLock")}
        {check("employee_self_service", "settings.selfService")}
        {check("show_signatures", "settings.signatures")}
        <Textarea label={t("settings.taxNotice")} name="taxNotice" value={settings.tax_notice} onChange={(event) => set("tax_notice", event.target.value)} rows={2} />
        <Textarea label={t("settings.footer")} name="footer" value={settings.footer_note ?? ""} onChange={(event) => set("footer_note", event.target.value)} rows={2} />
        <HintText small>{t("settings.appliesToNew")}</HintText>
        <Button loading={busy === "settings"} onClick={async () => {
          setBusy("settings");
          const result = await PayrollCycleRepository.saveSettings(settings);
          setBusy("");
          if (result.error) setError(payrollError(result.error, t)); else setSaved(true);
        }}>{saved ? t("settings.saved") : t("settings.save")}</Button>
      </Card>

      <Modal isOpen={Boolean(draft)} onClose={() => setDraft(null)} title={draft?.id ? t("components.edit") : t("components.add")} size="lg"
        footer={<Button loading={busy === "component"} onClick={saveComponent}>{t("components.save")}</Button>}>
        {d ? (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))", gap: "var(--space-2)" }}>
              <Input label={t("components.nameAr")} name="nameAr" value={d.name_ar} onChange={(event) => setD({ name_ar: event.target.value })} />
              <Input label={t("components.nameEn")} name="nameEn" value={d.name_en ?? ""} onChange={(event) => setD({ name_en: event.target.value })} />
              <Select label={t("components.category")} name="category" value={d.category ?? "earning"} onChange={(event) => setD({ category: event.target.value as PayrollComponent["category"], is_basic: false })}
                options={(["earning", "allowance", "deduction", "installment"] as const).map((v) => ({ value: v, label: t(`categories.${v}`) }))} />
              <Select label={t("components.source")} name="source" value={d.source ?? "variable"} onChange={(event) => setD({ source: event.target.value as PayrollComponent["source"] })}
                options={(["fixed", "variable"] as const).map((v) => ({ value: v, label: t(`components.sources.${v}`) }))} />
              <Select label={t("components.calc")} name="calc" value={d.calc_type ?? "amount"} onChange={(event) => setD({ calc_type: event.target.value as PayrollComponent["calc_type"], percent: null, percent_base: event.target.value === "percent" ? "basic" : null, base_component_id: null })}
                options={[{ value: "amount", label: t("components.amountType") }, { value: "percent", label: t("components.percentType") }]} />
              {d.calc_type === "percent" ? (
                <>
                  <Input label={t("components.percent")} name="percent" type="number" value={d.percent == null ? "" : String(d.percent)} onChange={(event) => setD({ percent: event.target.value === "" ? null : Number(event.target.value) })} />
                  <Select label={t("components.base")} name="base" value={d.percent_base ?? "basic"} onChange={(event) => setD({ percent_base: event.target.value as PayrollComponent["percent_base"], base_component_id: null })}
                    options={(["basic", "earnings", "component"] as const).map((v) => ({ value: v, label: t(`components.bases.${v}`) }))} />
                  {d.percent_base === "component" ? (
                    <Select label={t("components.baseComponent")} name="baseComponent" value={d.base_component_id ?? ""} onChange={(event) => setD({ base_component_id: event.target.value || null })}
                      options={[{ value: "", label: "-" }, ...components.filter((c) => c.calc_type === "amount" && c.id !== draft?.id).map((c) => ({ value: c.id, label: isRtl ? c.name_ar : c.name_en || c.name_ar }))]} />
                  ) : null}
                </>
              ) : null}
              <Input label={t("components.order")} name="order" type="number" value={String(d.sort_order ?? 100)} onChange={(event) => setD({ sort_order: Number(event.target.value) })} />
            </div>
            <label style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", marginTop: "var(--space-2)" }}>
              <input type="checkbox" checked={Boolean(d.include_in_net)} onChange={(event) => setD({ include_in_net: event.target.checked, is_basic: event.target.checked ? d.is_basic : false })} /> {t("components.inNetLabel")}
            </label>
            {!d.include_in_net ? <HintText small>{t("components.outsideNetHint")}</HintText> : null}
            {d.category === "allowance" ? (
              <label style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
                <input type="checkbox" checked={Boolean(d.include_in_combined)} onChange={(event) => setD({ include_in_combined: event.target.checked })} /> {t("components.inCombinedLabel")}
              </label>
            ) : null}
            {d.category === "earning" && d.calc_type === "amount" && d.include_in_net ? (
              <label style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
                <input type="checkbox" checked={Boolean(d.is_basic)} onChange={(event) => setD({ is_basic: event.target.checked, source: event.target.checked ? "fixed" : d.source })} /> {t("components.isBasicLabel")}
              </label>
            ) : null}
            <label style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
              <input type="checkbox" checked={Boolean(d.prorate)} onChange={(event) => setD({ prorate: event.target.checked })} /> {t("components.prorateLabel")}
            </label>
            {(d.category === "earning" || d.category === "allowance") && d.include_in_net ? (
              <>
                <label style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
                  <input type="checkbox" checked={d.taxable !== false} onChange={(event) => setD({ taxable: event.target.checked })} /> {t("components.taxableLabel")}
                </label>
                <label style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
                  <input type="checkbox" checked={Boolean(d.insurable)} onChange={(event) => setD({ insurable: event.target.checked })} /> {t("components.insurableLabel")}
                </label>
              </>
            ) : null}
            {d.source === "fixed" && !d.is_basic ? (
              <>
                <label style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
                  <input type="checkbox" checked={Boolean(d.applies_to_all)} onChange={(event) => setD({ applies_to_all: event.target.checked })} /> {t("components.appliesToAllLabel")}
                </label>
                {d.applies_to_all ? (
                  <>
                    {d.calc_type === "amount" ? (
                      <div style={{ maxWidth: 220 }}>
                        <Input label={t("components.defaultAmount")} name="defaultAmount" type="number" value={d.default_amount == null ? "" : String(d.default_amount)}
                          onChange={(event) => setD({ default_amount: event.target.value === "" ? null : Number(event.target.value) })} />
                      </div>
                    ) : null}
                    <HintText small>{t("components.appliesToAllHint")}</HintText>
                  </>
                ) : null}
              </>
            ) : null}
            <label style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
              <input type="checkbox" checked={d.is_active !== false} onChange={(event) => setD({ is_active: event.target.checked })} /> {t("components.activeLabel")}
            </label>
            {d.category === "deduction" && d.calc_type === "percent" ? <HintText small>{t("components.deductionPercentHint")}</HintText> : null}
          </>
        ) : null}
      </Modal>
    </PageShell>
  );
}
