import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import OrganizationRepository, { type Organization } from "../../core/repositories/OrganizationRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import Card from "../../components/common/Card";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";

type BreakRoundingMode = Organization["defaultBreakRoundingMode"];

// PROSM Time - § live UX review, user-directed: "look at the site
// Edit form, you'll find things that deserve to be in Settings." GPS
// accuracy tolerance, break rounding mode and grace tolerance are
// policy decisions that are almost always uniform across an
// organization's sites - unlike GPS coordinates or shift hours, which
// really do vary site to site. A new site's create form pre-fills
// from these; an already-configured site's own saved value is
// untouched here - it stays fully editable in that site's own Edit
// form for the rare site that needs to diverge.
export default function SiteDefaultsSettingsCard() {
  const { t } = useTranslation("settings");

  const [gpsAccuracyToleranceMeters, setGpsAccuracyToleranceMeters] = useState("50");
  const [breakRoundingMode, setBreakRoundingMode] = useState<BreakRoundingMode>("cumulative");
  const [graceToleranceMinutes, setGraceToleranceMinutes] = useState("5");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    OrganizationRepository.getCurrentOrganization().then((result) => {
      if (result.success && result.data) {
        setGpsAccuracyToleranceMeters(String(result.data.defaultGpsAccuracyToleranceMeters));
        setBreakRoundingMode(result.data.defaultBreakRoundingMode);
        setGraceToleranceMinutes(String(result.data.defaultGraceToleranceMinutes));
      }
      setLoading(false);
    });
  }, []);

  const handleSave = async () => {
    const parsedGps = Number(gpsAccuracyToleranceMeters);
    const parsedGrace = Number(graceToleranceMinutes);
    if (!Number.isFinite(parsedGps) || parsedGps <= 0) {
      setError(t("siteDefaults.invalidGpsTolerance"));
      return;
    }
    if (!Number.isFinite(parsedGrace) || parsedGrace < 0) {
      setError(t("siteDefaults.invalidGraceTolerance"));
      return;
    }

    setSaving(true);
    setError("");
    setSaved(false);
    const result = await OrganizationRepository.setSiteDefaults(Math.round(parsedGps), breakRoundingMode, Math.round(parsedGrace));
    setSaving(false);

    if (!result.success) {
      setError(humanizeBackendError(result.message, t) ?? t("siteDefaults.genericError"));
      return;
    }
    setSaved(true);
  };

  if (loading) return null;

  return (
    <Card title={t("siteDefaults.title")}>
      <p style={{ margin: "0 0 var(--space-3)", fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{t("siteDefaults.hint")}</p>

      <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
        <div style={{ maxWidth: 220 }}>
          <Input
            label={t("siteDefaults.gpsAccuracyToleranceLabel")}
            name="defaultGpsAccuracyTolerance"
            type="number"
            value={gpsAccuracyToleranceMeters}
            onChange={(event) => {
              setGpsAccuracyToleranceMeters(event.target.value);
              setSaved(false);
            }}
            disabled={saving}
          />
        </div>
        <div style={{ maxWidth: 220 }}>
          <Input
            label={t("siteDefaults.graceToleranceLabel")}
            name="defaultGraceTolerance"
            type="number"
            value={graceToleranceMinutes}
            onChange={(event) => {
              setGraceToleranceMinutes(event.target.value);
              setSaved(false);
            }}
            disabled={saving}
          />
        </div>
        <div style={{ maxWidth: 260 }}>
          <Select
            label={t("siteDefaults.breakRoundingModeLabel")}
            name="defaultBreakRoundingMode"
            value={breakRoundingMode}
            onChange={(event) => {
              setBreakRoundingMode(event.target.value as BreakRoundingMode);
              setSaved(false);
            }}
            disabled={saving}
            options={[
              { value: "cumulative", label: t("siteDefaults.breakRoundingMode.cumulative") },
              { value: "full_hour", label: t("siteDefaults.breakRoundingMode.full_hour") },
            ]}
          />
        </div>
      </div>

      <div style={{ marginTop: "var(--space-3)" }}>
        <Button onClick={handleSave} loading={saving}>
          {t("siteDefaults.saveAction")}
        </Button>
      </div>

      <ErrorText>{error}</ErrorText>
      {saved ? <p style={{ margin: "var(--space-2) 0 0", fontSize: "var(--font-sm)", color: "var(--status-success-text)" }}>{t("siteDefaults.saveSuccess")}</p> : null}
    </Card>
  );
}
