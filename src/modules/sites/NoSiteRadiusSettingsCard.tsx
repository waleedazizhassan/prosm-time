import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import OrganizationRepository from "../../core/repositories/OrganizationRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import Card from "../../components/common/Card";
import Input from "../../components/common/Input";
import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";

// PROSM Time - § live UX review, user-directed: "control every
// employee the same way, whether they clocked in at a registered site
// or not." A no-site (manual workplace) clock-in never had any
// geofence to check against - this is the one org-wide radius (the
// clock-in point itself becomes the center, per-session) applied from
// then on, reusing the exact same mid-shift presence-monitoring/exit-
// alert mechanism a real site's own geofence already uses. Owner-only,
// same "no direct client UPDATE grant" posture as the site policy
// fields above it on this same page.
export default function NoSiteRadiusSettingsCard() {
  const { t } = useTranslation("sites");

  const [radius, setRadius] = useState("500");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    OrganizationRepository.getCurrentOrganization().then((result) => {
      if (result.success && result.data) setRadius(String(result.data.noSiteAllowedRadiusMeters));
      setLoading(false);
    });
  }, []);

  const handleSave = async () => {
    const parsed = Number(radius);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError(t("noSiteRadius.invalidRadius"));
      return;
    }

    setSaving(true);
    setError("");
    setSaved(false);
    const result = await OrganizationRepository.setNoSiteAllowedRadius(Math.round(parsed));
    setSaving(false);

    if (!result.success) {
      setError(humanizeBackendError(result.message, t) ?? t("noSiteRadius.genericError"));
      return;
    }
    setSaved(true);
  };

  if (loading) return null;

  return (
    <Card title={t("noSiteRadius.title")}>
      <p style={{ margin: "0 0 var(--space-3)", fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{t("noSiteRadius.hint")}</p>
      <div style={{ maxWidth: 220 }}>
        <Input
          label={t("noSiteRadius.radiusLabel")}
          name="noSiteRadius"
          type="number"
          value={radius}
          onChange={(event) => {
            setRadius(event.target.value);
            setSaved(false);
          }}
          disabled={saving}
        />
      </div>
      <div style={{ marginTop: "var(--space-3)" }}>
        <Button onClick={handleSave} loading={saving}>
          {t("noSiteRadius.saveAction")}
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
      {saved ? <p style={{ margin: "var(--space-2) 0 0", fontSize: "var(--font-sm)", color: "var(--status-success-text)" }}>{t("noSiteRadius.saveSuccess")}</p> : null}
    </Card>
  );
}
