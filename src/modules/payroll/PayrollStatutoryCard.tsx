import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import PayrollCycleRepository, { type StatutoryBracket, type StatutoryConfig, type StatutoryState } from "../../core/repositories/PayrollCycleRepository";
import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Toggle from "../../components/common/Toggle";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import { payrollError } from "./payrollUi";

// 2026-11-09 (owner): Egyptian law is the default and every figure can be changed - a country's
// values come from its pack and the organisation edits its own copy. New cycles use the rules as
// they are when the cycle is created; earlier cycles keep theirs.
export default function PayrollStatutoryCard() {
  const { t, i18n } = useTranslation("payroll");
  const isRtl = i18n.dir() === "rtl";
  const [state, setState] = useState<StatutoryState | null>(null);
  const [cfg, setCfg] = useState<StatutoryConfig>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const load = useCallback(async () => {
    const result = await PayrollCycleRepository.getStatutory();
    if (result.error || !result.data) {
      setError(payrollError(result.error, t));
      return;
    }
    setState(result.data);
    setCfg(result.data.config ?? {});
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!state) return null;
  const ins = cfg.insurance;
  const tax = cfg.incomeTax;
  const fund = cfg.martyrsFund;
  const num = (value: string) => (value === "" ? 0 : Number(value));
  const setIns = (patch: Partial<NonNullable<StatutoryConfig["insurance"]>>) => setCfg((c) => ({ ...c, insurance: { ...c.insurance!, ...patch } }));
  const setTax = (patch: Partial<NonNullable<StatutoryConfig["incomeTax"]>>) => setCfg((c) => ({ ...c, incomeTax: { ...c.incomeTax!, ...patch } }));
  const setFund = (patch: Partial<NonNullable<StatutoryConfig["martyrsFund"]>>) => setCfg((c) => ({ ...c, martyrsFund: { ...c.martyrsFund!, ...patch } }));
  const setBracket = (index: number, patch: Partial<StatutoryBracket>) =>
    setTax({ brackets: tax!.brackets.map((b, i) => (i === index ? { ...b, ...patch } : b)) });

  const save = async () => {
    setBusy("save");
    setError("");
    setSaved("");
    const result = await PayrollCycleRepository.saveStatutory(cfg);
    setBusy("");
    if (result.error) setError(payrollError(result.error, t));
    else setSaved(t("statutory.saved"));
  };

  const reset = async (code: string) => {
    setBusy("reset");
    setError("");
    setSaved("");
    const result = await PayrollCycleRepository.resetStatutory(code);
    setBusy("");
    if (result.error) setError(payrollError(result.error, t));
    else {
      setSaved(t("statutory.resetDone"));
      await load();
    }
  };

  const country = state.countries.find((c) => c.code === state.countryCode);
  const row = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))", gap: "var(--space-2)" } as const;
  const head = (label: string, on: boolean, toggle: (v: boolean) => void) => (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", margin: "var(--space-3) 0 var(--space-1)" }}>
      <Toggle checked={on} onChange={toggle} label={label} />
      <strong>{label}</strong>
    </div>
  );

  return (
    <Card title={t("statutory.title")} subtitle={t("statutory.hint")}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "flex-end" }}>
        <div style={{ minWidth: 200 }}>
          <Select label={t("statutory.country")} name="statutoryCountry" value={state.countryCode}
            onChange={(event) => void reset(event.target.value)}
            options={state.countries.map((c) => ({ value: c.code, label: isRtl ? c.nameAr : c.nameEn }))} />
        </div>
        <Button size="sm" variant="ghost" loading={busy === "reset"} onClick={() => void reset(state.countryCode)}>{t("statutory.reset")}</Button>
      </div>
      {country?.note ? <HintText small>{country.note}</HintText> : null}

      {ins ? (
        <>
          {head(t("statutory.insurance"), ins.enabled, (v) => setIns({ enabled: v }))}
          {ins.enabled ? (
            <div style={row}>
              <Input label={t("statutory.employeeRate")} name="insEmp" type="number" value={String(ins.employeeRate)} onChange={(e) => setIns({ employeeRate: num(e.target.value) })} />
              <Input label={t("statutory.employerRate")} name="insEr" type="number" value={String(ins.employerRate)} onChange={(e) => setIns({ employerRate: num(e.target.value) })} />
              <Input label={t("statutory.minWage")} name="insMin" type="number" value={String(ins.minWage)} onChange={(e) => setIns({ minWage: num(e.target.value) })} />
              <Input label={t("statutory.maxWage")} name="insMax" type="number" value={ins.maxWage == null ? "" : String(ins.maxWage)} onChange={(e) => setIns({ maxWage: e.target.value === "" ? null : Number(e.target.value) })} />
              <Select label={t("statutory.base")} name="insBase" value={ins.base} onChange={(e) => setIns({ base: e.target.value as "basic" | "earnings" | "flagged" })}
                options={(["basic", "earnings", "flagged"] as const).map((v) => ({ value: v, label: t(`statutory.bases.${v}`) }))} />
            </div>
          ) : null}
        </>
      ) : null}

      {tax ? (
        <>
          {head(t("statutory.incomeTax"), tax.enabled, (v) => setTax({ enabled: v }))}
          {tax.enabled ? (
            <>
              <div style={row}>
                <Input label={t("statutory.exemption")} name="taxExempt" type="number" value={String(tax.personalExemption)} onChange={(e) => setTax({ personalExemption: num(e.target.value) })} />
              </div>
              <label style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", margin: "var(--space-1) 0" }}>
                <input type="checkbox" checked={tax.insuranceDeductible} onChange={(e) => setTax({ insuranceDeductible: e.target.checked })} /> {t("statutory.insuranceDeductible")}
              </label>
              <HintText small>{t("statutory.bracketsHint")}</HintText>
              <div style={{ display: "grid", gap: "var(--space-1)", maxWidth: 520 }}>
                {tax.brackets.map((b, i) => (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: "var(--space-2)", alignItems: "end" }}>
                    <Input label={i === tax.brackets.length - 1 ? t("statutory.above") : t("statutory.upTo")} name={`upTo${i}`} type="number"
                      value={b.upTo == null ? "" : String(b.upTo)} disabled={i === tax.brackets.length - 1}
                      onChange={(e) => setBracket(i, { upTo: e.target.value === "" ? null : Number(e.target.value) })} />
                    <Input label={t("statutory.rate")} name={`rate${i}`} type="number" value={String(b.rate)} onChange={(e) => setBracket(i, { rate: num(e.target.value) })} />
                    <Button size="xs" variant="ghost" disabled={tax.brackets.length <= 1}
                      onClick={() => setTax({ brackets: tax.brackets.filter((_, j) => j !== i).map((x, j, all) => (j === all.length - 1 ? { ...x, upTo: null } : x)) })}>{t("statutory.remove")}</Button>
                  </div>
                ))}
                <div>
                  <Button size="xs" variant="ghost" onClick={() => {
                    const last = tax.brackets[tax.brackets.length - 1];
                    const prevTop = tax.brackets.length > 1 ? tax.brackets[tax.brackets.length - 2].upTo ?? 0 : 0;
                    setTax({ brackets: [...tax.brackets.slice(0, -1), { upTo: prevTop + 10000, rate: last?.rate ?? 0 }, { upTo: null, rate: last?.rate ?? 0 }] });
                  }}>{t("statutory.addBracket")}</Button>
                </div>
              </div>
              {tax.tiers.length > 0 ? <HintText small>{t("statutory.tiersHint", { count: tax.tiers.length })}</HintText> : null}
            </>
          ) : null}
        </>
      ) : null}

      {fund ? (
        <>
          {head(t("statutory.fund"), fund.enabled, (v) => setFund({ enabled: v }))}
          {fund.enabled ? (
            <div style={row}>
              <Input label={t("statutory.fundRate")} name="fundRate" type="number" value={String(fund.rate)} onChange={(e) => setFund({ rate: num(e.target.value) })} />
            </div>
          ) : null}
        </>
      ) : null}

      <HintText small>{t("statutory.appliesToNew")}</HintText>
      <ErrorText>{error}</ErrorText>
      {saved ? <p role="status" style={{ color: "var(--status-success-text)", fontSize: "var(--font-sm)" }}>{saved}</p> : null}
      <Button loading={busy === "save"} onClick={save}>{t("statutory.save")}</Button>
    </Card>
  );
}
