import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import AllowanceRatesRepository, { BASIS_FIELDS, type AllowanceBasis, type BasisField } from "../../core/repositories/AllowanceRatesRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import Card from "../../components/common/Card";
import Select from "../../components/common/Select";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";

const BASIS_OPTIONS: AllowanceBasis[] = ["fixed_per_day", "per_hour", "per_extra_day"];

// v2.3.43 step 4 (item 6): how each daily allowance is calculated, for the
// whole organisation (the Owner's choice, checked on the server). Overtime is
// always per hour from the exact minutes, extra days per extra day.
export default function AllowanceBasisCard() {
  const { t } = useTranslation("allowances");
  const [basis, setBasis] = useState<Record<BasisField, AllowanceBasis> | null>(null);
  const [saving, setSaving] = useState<BasisField | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    AllowanceRatesRepository.getBasis().then((result) => setBasis(result.data));
  }, []);

  const handleChange = async (field: BasisField, value: AllowanceBasis) => {
    if (!basis) return;
    setSaving(field);
    setError("");
    const result = await AllowanceRatesRepository.setBasis(field, value);
    setSaving(null);
    if (!result.success) {
      setError(humanizeBackendError(result.message, t) ?? t("basis.genericError"));
      return;
    }
    setBasis({ ...basis, [field]: value });
  };

  if (!basis) return null;

  return (
    <Card title={t("basis.title")}>
      <HintText small>{t("basis.hint")}</HintText>
      <div style={{ display: "grid", gap: "var(--space-2)", gridTemplateColumns: "repeat(auto-fit, minmax(14rem, 1fr))" }}>
        {BASIS_FIELDS.map((field) => (
          <Select
            key={field}
            label={t(`prices.field.${field}`)}
            name={`basis-${field}`}
            value={basis[field]}
            disabled={saving !== null}
            onChange={(event) => void handleChange(field, event.target.value as AllowanceBasis)}
            options={BASIS_OPTIONS.map((option) => ({ value: option, label: t(`basis.option.${option}`) }))}
          />
        ))}
      </div>
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
