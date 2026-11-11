import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { requireSupabaseClient } from "../../core/api/supabaseClient";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import Card from "../../components/common/Card";
import HintText from "../../components/common/HintText";
import ErrorText from "../../components/common/ErrorText";
import SuccessText from "../../components/common/SuccessText";
import styles from "./OvertimeLateTargetCard.module.css";

type Target = "payroll" | "allowances" | "none";

// Owner 2026-11-10: "in some companies lateness and overtime go to the salary, in others to the
// allowances - and a third choice: not counted at all. With payroll in the plan: salary / allowances /
// not counted; with allowances only: counted or not; with neither: nothing to choose."
export default function OvertimeLateTargetCard({ hasPayroll, hasAllowances }: { hasPayroll: boolean; hasAllowances: boolean }) {
  const { t } = useTranslation("settings");
  const [target, setTarget] = useState<Target | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void requireSupabaseClient().rpc("get_prosm_time_overtime_late_target").then(({ data }) => setTarget((data as Target) ?? "none"));
  }, []);

  if (!hasPayroll && !hasAllowances) return null;
  const options: Target[] = hasPayroll ? (hasAllowances ? ["payroll", "allowances", "none"] : ["payroll", "none"]) : ["allowances", "none"];

  const choose = async (next: Target) => {
    if (next === target || saving) return;
    setSaving(true);
    setError("");
    setSaved(false);
    const { error: rpcError } = await requireSupabaseClient().rpc("set_prosm_time_overtime_late_target", { p_target: next });
    setSaving(false);
    if (rpcError) {
      setError(humanizeBackendError(rpcError.message, t) ?? t("overtimeTarget.error"));
      return;
    }
    setTarget(next);
    setSaved(true);
  };

  return (
    <Card title={t("overtimeTarget.title")}>
      <HintText>{t("overtimeTarget.hint")}</HintText>
      <div className={styles.options} role="radiogroup" aria-label={t("overtimeTarget.title")}>
        {options.map((key) => (
          <button key={key} type="button" role="radio" aria-checked={target === key} disabled={saving || target === null}
            className={target === key ? `${styles.option} ${styles.active}` : styles.option} onClick={() => void choose(key)}>
            <strong>{t(`overtimeTarget.${!hasPayroll && key === "allowances" ? "counted" : key}.label`)}</strong>
            <span>{t(`overtimeTarget.${!hasPayroll && key === "allowances" ? "counted" : key}.hint`)}</span>
          </button>
        ))}
      </div>
      <ErrorText>{error}</ErrorText>
      {saved ? <SuccessText>{t("overtimeTarget.saved")}</SuccessText> : null}
    </Card>
  );
}
