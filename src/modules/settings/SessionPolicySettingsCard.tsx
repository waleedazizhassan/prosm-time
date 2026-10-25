import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import OrganizationRepository from "../../core/repositories/OrganizationRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import Card from "../../components/common/Card";
import Input from "../../components/common/Input";
import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";

// v2.3.43 step 2 (item 11): after how many hours an open shift asks "still
// working?" (and tells the managers once), and after how many it is closed
// automatically with its hours waiting for review. Organisation-wide;
// settings.session_policy (the Owner by default), checked on the server.
export default function SessionPolicySettingsCard() {
  const { t } = useTranslation("settings");
  const [alertHours, setAlertHours] = useState("12");
  const [maxHours, setMaxHours] = useState("24");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    OrganizationRepository.getCurrentOrganization().then((result) => {
      if (result.success && result.data) {
        setAlertHours(String(result.data.openSessionAlertHours));
        setMaxHours(String(result.data.openSessionMaxHours));
      }
      setLoading(false);
    });
  }, []);

  const handleSave = async () => {
    const alert = Number(alertHours);
    const max = Number(maxHours);
    if (!Number.isInteger(alert) || !Number.isInteger(max) || alert < 1 || max > 72 || alert >= max) {
      setError(t("sessionPolicy.invalid"));
      return;
    }
    setSaving(true);
    setError("");
    setSaved(false);
    const result = await OrganizationRepository.setSessionPolicy(alert, max);
    setSaving(false);
    if (!result.success) {
      setError(humanizeBackendError(result.message, t) ?? t("sessionPolicy.genericError"));
      return;
    }
    setSaved(true);
  };

  if (loading) return null;

  return (
    <Card title={t("sessionPolicy.title")}>
      <HintText>{t("sessionPolicy.hint")}</HintText>
      <Input label={t("sessionPolicy.alertHoursLabel")} name="openSessionAlertHours" type="number" value={alertHours} onChange={(event) => { setAlertHours(event.target.value); setSaved(false); }} disabled={saving} />
      <Input label={t("sessionPolicy.maxHoursLabel")} name="openSessionMaxHours" type="number" value={maxHours} onChange={(event) => { setMaxHours(event.target.value); setSaved(false); }} disabled={saving} />
      <ErrorText>{error}</ErrorText>
      {saved ? <HintText small>{t("sessionPolicy.saved")}</HintText> : null}
      <Button onClick={handleSave} loading={saving}>
        {t("sessionPolicy.save")}
      </Button>
    </Card>
  );
}
