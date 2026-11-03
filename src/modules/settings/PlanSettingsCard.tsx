import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";

import LicenseRepository from "../../core/repositories/LicenseRepository";
import PlanRepository, { type PlanStatus } from "../../core/repositories/PlanRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import Button from "../../components/common/Button";
import Card from "../../components/common/Card";
import ErrorText from "../../components/common/ErrorText";
import Input from "../../components/common/Input";
import { appLocale } from "../../core/utils/formatDate";
import { useAuth } from "../../core/context/AuthContext";
import usePlanFeatures, { resetPlanFeatures, type PlanFeature } from "../../core/hooks/usePlanFeatures";

// Owner 2026-11-03: what the plan includes, in the order of the plans sheet.
const FEATURE_ROWS: PlanFeature[] = ["on_behalf", "kiosk", "leave", "allowances", "export", "payroll_export", "clock_rules", "scheduling", "roles_manager", "audit", "sos", "roles_all", "clock_suggestion", "labor_cost", "daily_summary", "manager_alerts"];

// The Owner's plan: which one, what is used, when it ends, and a code PROSM
// issued. In the Google Play build too: it shows state and takes no payment.
export default function PlanSettingsCard() {
  const { t, i18n } = useTranslation("settings");
  const [status, setStatus] = useState<PlanStatus | null>(null);
  const [code, setCode] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const { profile } = useAuth();
  const { plan: features } = usePlanFeatures(profile?.id);

  const location = useLocation();
  // owner 2026-11-03: a licence-change notification opens this card itself
  useEffect(() => {
    if (status && location.hash === "#plan") document.getElementById("plan")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [status, location.hash]);

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
    resetPlanFeatures();
    load();
  };

  return (
    <div id="plan" style={{ scrollMarginTop: 80 }}>
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
      {features ? (
        <div style={{ marginTop: "var(--space-4)" }}>
          <p style={{ margin: "0 0 var(--space-2)", fontWeight: "var(--font-weight-semibold)" }}>{t("plan.includes")}</p>
          <p style={{ margin: "0 0 var(--space-2)", fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{t("plan.always")}</p>
          <p style={{ margin: "0 0 var(--space-2)", fontSize: "var(--font-sm)" }}>
            {features.historyDays ? t("plan.history", { count: Math.round(features.historyDays / 365) }) : t("plan.historyAll")}
          </p>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(240px, 100%), 1fr))", gap: "var(--space-1) var(--space-4)" }}>
            {FEATURE_ROWS.map((feature) => {
              const on = features.features[feature] === true;
              return (
                <li key={feature} aria-label={`${t(`plan.features.${feature}`)}: ${on ? t("plan.included") : t("plan.notIncluded")}`} style={{ display: "flex", gap: "var(--space-2)", fontSize: "var(--font-sm)", color: on ? "var(--text-primary)" : "var(--text-secondary)" }}>
                  <span aria-hidden="true" style={{ color: on ? "var(--status-success-text)" : "var(--text-secondary)", width: 14 }}>{on ? "✓" : "—"}</span>
                  <span>
                    {t(`plan.features.${feature}`)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {/* owner 2026-11-03: an active licence is changed and renewed from PROSM Platform Manager,
          so a code is asked for only on a trial (to start paying) or once the licence has ended. */}
      {status.status === "active" ? (
        <p style={{ margin: "var(--space-4) 0 0", fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{t("plan.managedByProsm")}</p>
      ) : (
        <>
          <div style={{ marginTop: "var(--space-4)", maxWidth: 420 }}>
            <Input name="activationCode" label={t("plan.codeLabel")} value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-start", marginTop: "var(--space-3)" }}>
            <Button onClick={redeem} loading={saving} disabled={!code.trim() || saving}>
              {t("plan.redeem")}
            </Button>
          </div>
        </>
      )}
      <ErrorText>{error}</ErrorText>
      {saved ? <p style={{ color: "var(--status-success-text)", fontSize: "var(--font-sm)" }}>{t("plan.redeemed")}</p> : null}
    </Card>
    </div>
  );
}
