import { useState } from "react";
import { useTranslation } from "react-i18next";

import Card from "../../../components/common/Card";
import Button from "../../../components/common/Button";
import Input from "../../../components/common/Input";
import Select from "../../../components/common/Select";
import ErrorText from "../../../components/common/ErrorText";
import HintText from "../../../components/common/HintText";
import humanizeBackendError from "../../../core/utils/humanizeBackendError";
import TaxConfigRepository, { type Preview, type TaxRules } from "../../../core/repositories/TaxConfigRepository";

// HR suite feature 4: "try it" - a salary in, the tax, the insurance and the net out, computed on the
// server by the very function the payroll uses (on the rules as they are on screen, before saving).
export default function TaxCalculator({ rules, currency }: { rules: TaxRules | { preset: string }; currency: string }) {
  const { t, i18n } = useTranslation("taxConfig");
  const [input, setInput] = useState({ basic: "10000", taxableAllowances: "", nonTaxableAllowances: "", preTaxDeductions: "", category: "" });
  const [result, setResult] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const categories = "insurance" in rules && rules.insurance?.enabled ? rules.insurance.categories : [];
  const money = (v: number) => new Intl.NumberFormat(i18n.language, { style: "currency", currency, maximumFractionDigits: 2 }).format(v);

  const run = async () => {
    setBusy(true);
    setError("");
    const r = await TaxConfigRepository.preview(rules, input);
    setBusy(false);
    if (r.error) return setError(humanizeBackendError(r.error, t) ?? t("error"));
    setResult(r.data);
  };

  const field = (key: keyof typeof input, label: string) => (
    <Input label={label} name={`calc_${key}`} type="number" value={input[key]} onChange={(e) => setInput({ ...input, [key]: e.target.value })} />
  );

  return (
    <Card title={t("calc.title")}>
      <HintText small>{t("calc.hint")}</HintText>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))", gap: "var(--space-2)" }}>
        {field("basic", t("calc.basic"))}
        {field("taxableAllowances", t("calc.taxableAllowances"))}
        {field("nonTaxableAllowances", t("calc.nonTaxableAllowances"))}
        {field("preTaxDeductions", t("calc.preTax"))}
        {categories.length > 1 ? (
          <Select label={t("calc.category")} name="calcCategory" value={input.category} onChange={(e) => setInput({ ...input, category: e.target.value })}
            options={[{ value: "", label: t("calc.defaultCategory") }, ...categories.map((c) => ({ value: c.code, label: c.name || c.code }))]} />
        ) : null}
      </div>
      <Button loading={busy} onClick={() => void run()}>{t("calc.run")}</Button>
      <ErrorText>{error}</ErrorText>
      {result ? (
        <table style={{ width: "100%", marginTop: "var(--space-3)", borderCollapse: "collapse" }}>
          <tbody>
            <tr><td>{t("calc.gross")}</td><td style={{ textAlign: "end" }}><strong>{money(result.gross)}</strong></td></tr>
            {result.lines.filter((l) => l.inNet).map((l, i) => (
              <tr key={i}>
                <td>{(i18n.language === "ar" ? l.nameAr : l.nameEn) ?? l.nameAr ?? l.nameEn ?? t(`rules.${l.rule}`, { defaultValue: l.rule })}{l.percent != null ? ` (${l.percent}%)` : ""}</td>
                <td style={{ textAlign: "end" }}>− {money(l.amount)}</td>
              </tr>
            ))}
            <tr style={{ borderTop: "1px solid var(--border-light)" }}><td><strong>{t("calc.net")}</strong></td><td style={{ textAlign: "end" }}><strong>{money(result.net)}</strong></td></tr>
            {result.employerCost > 0 ? <tr><td style={{ color: "var(--text-secondary)" }}>{t("calc.employerCost")}</td><td style={{ textAlign: "end", color: "var(--text-secondary)" }}>{money(result.employerCost)}</td></tr> : null}
          </tbody>
        </table>
      ) : null}
    </Card>
  );
}
