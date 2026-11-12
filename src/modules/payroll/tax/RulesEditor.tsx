import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";

import Card from "../../../components/common/Card";
import Button from "../../../components/common/Button";
import Input from "../../../components/common/Input";
import Select from "../../../components/common/Select";
import Toggle from "../../../components/common/Toggle";
import HintText from "../../../components/common/HintText";
import type { InsuranceCategory, InsuranceRule, Levy, TaxRelief, TaxRules } from "../../../core/repositories/TaxConfigRepository";

const num = (v: string): number | null => (v.trim() === "" ? null : Number(v));
const str = (v: number | null | undefined) => (v == null ? "" : String(v));
const BASES = ["basic", "gross", "taxable", "insurable"] as const;

// HR suite feature 4: the rules on one page - income tax (brackets, the exemption, the high-income tiers),
// insurance (categories, each with the employee's and the employer's rate and the insurable wage limits)
// and other levies. Read-only while the ready values are shown; the server checks everything on save.
export default function RulesEditor({ rules, onChange, readOnly }: { rules: TaxRules; onChange: (next: TaxRules) => void; readOnly: boolean }) {
  const { t } = useTranslation("taxConfig");
  const tax = rules.incomeTax!;
  const ins = rules.insurance!;
  const levies = rules.levies ?? [];
  const setTax = (patch: Partial<NonNullable<TaxRules["incomeTax"]>>) => onChange({ ...rules, incomeTax: { ...tax, ...patch } });
  const setIns = (patch: Partial<NonNullable<TaxRules["insurance"]>>) => onChange({ ...rules, insurance: { ...ins, ...patch } });

  const exemption = tax.reliefs.find((r) => r.kind === "fixed");
  const deductsContributions = tax.reliefs.some((r) => r.kind === "employee_contributions");
  const setExemption = (value: number | null) => {
    const others = tax.reliefs.filter((r) => r.kind !== "fixed");
    setTax({ reliefs: value == null || value === 0 ? others : [...others, { ...(exemption ?? { kind: "fixed", code: "personal_exemption" }), value } as TaxRelief] });
  };
  const setDeducts = (on: boolean) =>
    setTax({ reliefs: on ? [{ kind: "employee_contributions" }, ...tax.reliefs.filter((r) => r.kind !== "employee_contributions")] : tax.reliefs.filter((r) => r.kind !== "employee_contributions") });

  const setBracket = (i: number, patch: Partial<{ upTo: number | null; rate: number }>) =>
    setTax({ brackets: tax.brackets.map((b, j) => (j === i ? { ...b, ...patch } : b)) });
  const addBracket = () => {
    const last = tax.brackets[tax.brackets.length - 1];
    const before = tax.brackets.slice(0, -1);
    const prevTop = before.length ? before[before.length - 1].upTo ?? 0 : 0;
    setTax({ brackets: [...before, { upTo: prevTop + 1, rate: last?.rate ?? 0 }, { upTo: null, rate: last?.rate ?? 0 }] });
  };

  const rule = (c: InsuranceCategory, payer: InsuranceRule["payer"]) => c.branches[0]?.rules.find((r) => r.payer === payer);
  const setCategory = (i: number, patch: { name?: string; employee?: number | null; employer?: number | null; min?: number | null; max?: number | null; baseCode?: string }) =>
    setIns({
      categories: ins.categories.map((c, j) => {
        if (j !== i) return c;
        const branch = c.branches[0] ?? { code: "social", baseCode: "basic", useFixedWage: true, rules: [] };
        const rulesOf = (["employee", "employer"] as const).map((payer) => {
          const r = branch.rules.find((x) => x.payer === payer) ?? { payer, rate: 0 };
          return {
            ...r,
            rate: payer === "employee" && patch.employee !== undefined ? patch.employee ?? 0 : payer === "employer" && patch.employer !== undefined ? patch.employer ?? 0 : r.rate,
            minBase: patch.min !== undefined ? patch.min : r.minBase ?? null,
            maxBase: patch.max !== undefined ? patch.max : r.maxBase ?? null,
          };
        });
        return { ...c, name: patch.name ?? c.name, branches: [{ ...branch, baseCode: patch.baseCode ?? branch.baseCode, rules: rulesOf }, ...c.branches.slice(1)] };
      }),
    });
  const addCategory = () => {
    const code = `cat_${ins.categories.length + 1}_${Math.random().toString(36).slice(2, 6)}`;
    setIns({ categories: [...ins.categories, { code, name: "", branches: [{ code: "social", baseCode: "basic", useFixedWage: true, rules: [{ payer: "employee", rate: 0 }, { payer: "employer", rate: 0 }] }] }] });
  };
  const setLevy = (i: number, patch: Partial<Levy>) => onChange({ ...rules, levies: levies.map((l, j) => (j === i ? { ...l, ...patch } : l)) });

  return (
    <>
      <Card title={t("tax.title")}>
        <Toggle checked={tax.enabled} onChange={(on) => setTax({ enabled: on })} disabled={readOnly} label={t("tax.enabled")} />
        {tax.enabled ? (
          <div style={{ display: "grid", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))", gap: "var(--space-2)" }}>
              <Select label={t("tax.period")} name="taxPeriod" value={tax.period} disabled={readOnly} onChange={(e) => setTax({ period: e.target.value as "monthly" })}
                options={[{ value: "annual_div_12", label: t("tax.annual") }, { value: "monthly", label: t("tax.monthly") }]} />
              <Input label={t("tax.exemption")} name="taxExemption" type="number" disabled={readOnly} value={str(exemption?.value)} onChange={(e) => setExemption(num(e.target.value))} />
            </div>
            <Toggle checked={deductsContributions} onChange={setDeducts} disabled={readOnly} label={t("tax.deductInsurance")} />
            <Toggle checked={Boolean(tax.roundDown)} onChange={(on) => setTax({ roundDown: on })} disabled={readOnly} label={t("tax.roundDown")} />
            <strong>{t("tax.brackets")}</strong>
            <div role="table" style={{ display: "grid", gap: 6 }}>
              {tax.brackets.map((b, i) => {
                const from = i === 0 ? 0 : tax.brackets[i - 1].upTo ?? 0;
                const last = i === tax.brackets.length - 1;
                return (
                  <div key={i} role="row" style={{ display: "flex", gap: "var(--space-2)", alignItems: "flex-end", flexWrap: "wrap" }}>
                    <span style={{ minWidth: "6rem", marginBottom: "var(--space-4)" }}>{t("tax.from", { value: from })}</span>
                    <div style={{ width: "9rem" }}>
                      {last ? <span style={{ display: "block", marginBottom: "var(--space-4)" }}>{t("tax.andAbove")}</span> : (
                        <Input label={t("tax.upTo")} name={`upTo${i}`} type="number" disabled={readOnly} value={str(b.upTo)} onChange={(e) => setBracket(i, { upTo: num(e.target.value) })} />
                      )}
                    </div>
                    <div style={{ width: "7rem" }}>
                      <Input label={t("tax.rate")} name={`rate${i}`} type="number" disabled={readOnly} value={str(b.rate)} onChange={(e) => setBracket(i, { rate: num(e.target.value) ?? 0 })} />
                    </div>
                    {!readOnly && tax.brackets.length > 1 && !last ? (
                      <Button size="sm" variant="ghost" aria-label={t("remove")} style={{ marginBottom: "var(--space-4)" }}
                        onClick={() => setTax({ brackets: tax.brackets.filter((_, j) => j !== i) })}><Trash2 size={14} /></Button>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {!readOnly ? <Button size="sm" variant="ghost" onClick={addBracket}><Plus size={14} /> {t("tax.addBracket")}</Button> : null}
            {tax.tiers.length > 0 ? (
              <>
                <strong>{t("tax.tiers")}</strong>
                <HintText small>{t("tax.tiersHint")}</HintText>
                <ul style={{ margin: 0, paddingInlineStart: "var(--space-4)" }}>
                  {tax.tiers.map((tier, i) => <li key={i}>{t("tax.tierRow", { above: tier.above, n: tier.startBracket + 1 })}</li>)}
                </ul>
              </>
            ) : null}
          </div>
        ) : null}
      </Card>

      <Card title={t("ins.title")}>
        <Toggle checked={ins.enabled} onChange={(on) => setIns({ enabled: on })} disabled={readOnly} label={t("ins.enabled")} />
        {ins.enabled ? (
          <div style={{ display: "grid", gap: "var(--space-3)", marginTop: "var(--space-2)" }}>
            {ins.categories.map((c, i) => (
              <div key={c.code} style={{ border: "1px solid var(--border-light)", borderRadius: "var(--radius-md)", padding: "var(--space-3)", display: "grid", gap: "var(--space-2)" }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))", gap: "var(--space-2)" }}>
                  {ins.categories.length > 1 || !readOnly ? (
                    <Input label={t("ins.categoryName")} name={`cat${i}`} disabled={readOnly} value={c.name ?? ""} onChange={(e) => setCategory(i, { name: e.target.value })} />
                  ) : null}
                  <Input label={t("ins.employeeRate")} name={`emp${i}`} type="number" disabled={readOnly} value={str(rule(c, "employee")?.rate)} onChange={(e) => setCategory(i, { employee: num(e.target.value) })} />
                  <Input label={t("ins.employerRate")} name={`er${i}`} type="number" disabled={readOnly} value={str(rule(c, "employer")?.rate)} onChange={(e) => setCategory(i, { employer: num(e.target.value) })} />
                  <Input label={t("ins.min")} name={`min${i}`} type="number" disabled={readOnly} value={str(rule(c, "employee")?.minBase)} onChange={(e) => setCategory(i, { min: num(e.target.value) })} />
                  <Input label={t("ins.max")} name={`max${i}`} type="number" disabled={readOnly} value={str(rule(c, "employee")?.maxBase)} onChange={(e) => setCategory(i, { max: num(e.target.value) })} />
                  <Select label={t("ins.base")} name={`base${i}`} disabled={readOnly} value={c.branches[0]?.baseCode ?? "basic"} onChange={(e) => setCategory(i, { baseCode: e.target.value })}
                    options={BASES.filter((b) => b !== "taxable").map((b) => ({ value: b, label: t(`bases.${b}`) }))} />
                </div>
                {!readOnly && ins.categories.length > 1 ? (
                  <Button size="sm" variant="ghost" onClick={() => setIns({ categories: ins.categories.filter((_, j) => j !== i) })}><Trash2 size={14} /> {t("ins.removeCategory")}</Button>
                ) : null}
              </div>
            ))}
            {!readOnly ? <Button size="sm" variant="ghost" onClick={addCategory}><Plus size={14} /> {t("ins.addCategory")}</Button> : null}
            {ins.categories.length > 1 ? (
              <Select label={t("ins.defaultCategory")} name="defaultCategory" disabled={readOnly} value={ins.defaultCategory ?? ins.categories[0].code}
                onChange={(e) => setIns({ defaultCategory: e.target.value })} options={ins.categories.map((c) => ({ value: c.code, label: c.name || c.code }))} />
            ) : null}
            <HintText small>{t("ins.fixedWageHint")}</HintText>
          </div>
        ) : null}
      </Card>

      <Card title={t("levy.title")}>
        <HintText small>{t("levy.hint")}</HintText>
        {levies.map((l, i) => (
          <div key={i} style={{ display: "flex", gap: "var(--space-2)", alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 10rem" }}>
              <Input label={t("levy.name")} name={`levyName${i}`} disabled={readOnly} value={l.nameAr ?? l.nameEn ?? ""} onChange={(e) => setLevy(i, { nameAr: e.target.value, nameEn: e.target.value })} />
            </div>
            <div style={{ width: "7rem" }}>
              <Input label={t("levy.rate")} name={`levyRate${i}`} type="number" disabled={readOnly} value={str(l.rate)} onChange={(e) => setLevy(i, { rate: num(e.target.value) ?? 0 })} />
            </div>
            <div style={{ width: "9rem" }}>
              <Select label={t("levy.base")} name={`levyBase${i}`} disabled={readOnly} value={l.baseCode} onChange={(e) => setLevy(i, { baseCode: e.target.value })}
                options={BASES.map((b) => ({ value: b, label: t(`bases.${b}`) }))} />
            </div>
            <div style={{ width: "9rem" }}>
              <Select label={t("levy.payer")} name={`levyPayer${i}`} disabled={readOnly} value={l.payer} onChange={(e) => setLevy(i, { payer: e.target.value as Levy["payer"] })}
                options={[{ value: "employee", label: t("levy.employee") }, { value: "employer", label: t("levy.employer") }]} />
            </div>
            <div style={{ marginBottom: "var(--space-4)" }}><Toggle checked={l.enabled !== false} disabled={readOnly} onChange={(on) => setLevy(i, { enabled: on })} label={t("levy.on")} /></div>
            {!readOnly ? <Button size="sm" variant="ghost" aria-label={t("remove")} style={{ marginBottom: "var(--space-4)" }} onClick={() => onChange({ ...rules, levies: levies.filter((_, j) => j !== i) })}><Trash2 size={14} /></Button> : null}
          </div>
        ))}
        {!readOnly ? (
          <Button size="sm" variant="ghost" onClick={() => onChange({ ...rules, levies: [...levies, { code: `levy_${levies.length + 1}`, enabled: true, payer: "employee", baseCode: "gross", rate: 0, nameAr: "", nameEn: "" }] })}>
            <Plus size={14} /> {t("levy.add")}
          </Button>
        ) : null}
      </Card>
    </>
  );
}
