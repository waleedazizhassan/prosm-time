import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import LicenseRepository from "../../core/repositories/LicenseRepository";
import PlanRepository, { type PlanStatus } from "../../core/repositories/PlanRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import Button from "../../components/common/Button";
import Card from "../../components/common/Card";
import ErrorText from "../../components/common/ErrorText";
import Input from "../../components/common/Input";
import { appLocale } from "../../core/utils/formatDate";

// The Owner's plan: which one, what is used, when it ends, and a code PROSM
// issued. In the Google Play build too: it shows state and takes no payment.
export default function PlanSettingsCard() {
  const { t, i18n } = useTranslation("settings");
  const [status, setStatus] = useState<PlanStatus | null>(null);
  const [code, setCode] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => {
    void PlanRepository.getStatus().then(setStatus);
  }, []);
  useEffect(load, [load]);

  if (!status) return null;

  const usage = (used: number, max: number | null) => (max === null ? String(used) : t("plan.usage", { used, max }));
  const date = status.endsAt ? new Date(status.endsAt).toLocaleDateString(appLocale(i18n.language)) : t("plan.noEnd");

  const redeem = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    // Platform Manager issues the codes: the licence path first, then a code held in this project.
    const license = await LicenseRepository.activateWithCode(code.trim());
    const result = license.success ? { success: true, error: undefined } : await PlanRepository.redeem(code);
    setSaving(false);
    if (!result.success) {
      setError(humanizeBackendError(result.error, t) ?? t("plan.redeemFailed"));
      return;
    }
    setCode("");
    setSaved(true);
    load();
  };

  return (
    <Card title={t("plan.title")}>
      <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "var(--space-3)", margin: 0 }}>
        <div>
          <dt>{t("plan.current")}</dt>
          <dd style={{ margin: 0 }}>
            {t(`plan.names.${status.plan}`)}
            {status.status === "trial" ? ` · ${t("plan.trial")}` : ""}
          </dd>
        </div>
        <div>
          <dt>{t("plan.employees")}</dt>
          <dd style={{ margin: 0 }}>{usage(status.employees, status.maxEmployees)}</dd>
        </div>
        <div>
          <dt>{t("plan.sites")}</dt>
          <dd style={{ margin: 0 }}>{usage(status.sites, status.maxSites)}</dd>
        </div>
        <div>
          <dt>{t("plan.ends")}</dt>
          <dd style={{ margin: 0 }}>{date}</dd>
        </div>
      </dl>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "flex-end", marginTop: "var(--space-4)" }}>
        <Input name="activationCode" label={t("plan.codeLabel")} value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" />
        <Button onClick={redeem} loading={saving} disabled={!code.trim() || saving}>
          {t("plan.redeem")}
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
      {saved ? <p style={{ color: "var(--status-success-text)", fontSize: "var(--font-sm)" }}>{t("plan.redeemed")}</p> : null}
    </Card>
  );
}
