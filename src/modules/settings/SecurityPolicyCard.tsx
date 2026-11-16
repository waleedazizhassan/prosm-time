import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { requireSupabaseClient } from "../../core/api/supabaseClient";
import { withStepUp } from "../../core/auth/stepUp";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import Card from "../../components/common/Card";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import SuccessText from "../../components/common/SuccessText";

interface Policy { stepUp: boolean; mfa: boolean; platformStepUp: boolean; platformMfa: boolean; canChange: boolean }

// Owner 2026-11-16 ("I see no buttons to choose two-step verification for the sensitive actions"): the organisation's
// own protection for sensitive actions - approving / reopening payroll, publishing payslips, API keys, changing
// permissions, transferring ownership. Hidden until the server has the setting (migration 20261116160000).
export default function SecurityPolicyCard() {
  const { t } = useTranslation("settings");
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void requireSupabaseClient().rpc("get_prosm_time_security_policy").then(({ data, error: e }) => { if (!e && data) setPolicy(data as Policy); });
  }, []);
  if (!policy) return null;

  const save = async (stepUp: boolean, mfa: boolean) => {
    setSaving(true);
    setError("");
    setSaved(false);
    // switching a protection off asks the owner to confirm who they are (the server checks it)
    const result = await withStepUp("security.change", async () => {
      const { error: e } = await requireSupabaseClient().rpc("set_prosm_time_security_policy", { p_step_up: stepUp, p_mfa: mfa });
      return { error: e?.message ?? null };
    });
    setSaving(false);
    if (result.error) {
      setError(humanizeBackendError(result.error, t) ?? t("security.saveFailed"));
      return;
    }
    setPolicy({ ...policy, stepUp: stepUp || mfa, mfa });
    setSaved(true);
  };

  const option = (key: "stepUp" | "mfa", checked: boolean, forced: boolean, onChange: (value: boolean) => void) => (
    <label style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-start", cursor: policy.canChange && !forced ? "pointer" : "default" }}>
      <input type="checkbox" checked={checked || forced} disabled={!policy.canChange || forced || saving} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 4 }} />
      <span>
        <b>{t(`security.${key}.title`)}</b>
        <HintText small>{t(`security.${key}.hint`)}</HintText>
        {forced ? <HintText small>{t("security.platformOn")}</HintText> : null}
      </span>
    </label>
  );

  return (
    <Card title={t("security.title")} subtitle={t("security.subtitle")}>
      <div style={{ display: "grid", gap: "var(--space-3)" }}>
        {option("stepUp", policy.stepUp, policy.platformStepUp, (value) => void save(value, value ? policy.mfa : false))}
        {option("mfa", policy.mfa, policy.platformMfa, (value) => void save(value || policy.stepUp, value))}
        <HintText small>
          {t("security.howTo")} <Link to="/me?tab=security">{t("security.openMine")}</Link>
        </HintText>
        <ErrorText>{error}</ErrorText>
        {saved ? <SuccessText>{t("security.saved")}</SuccessText> : null}
      </div>
    </Card>
  );
}
