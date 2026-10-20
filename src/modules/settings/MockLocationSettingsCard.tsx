import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import OrganizationRepository from "../../core/repositories/OrganizationRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import Card from "../../components/common/Card";
import Toggle from "../../components/common/Toggle";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";

// Audit 2.4 (2026-10-13) - "Reject clock-in/out from a fake location",
// organisation-wide, Owner only (checked server-side). Off by default: a
// location the Android device reports as simulated is then recorded and
// sent to the managers for review instead.
export default function MockLocationSettingsCard() {
  const { t } = useTranslation("settings");

  const [reject, setReject] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    OrganizationRepository.getCurrentOrganization().then((result) => {
      if (result.success && result.data) setReject(result.data.rejectMockLocation);
      setLoading(false);
    });
  }, []);

  const handleChange = async (next: boolean) => {
    setSaving(true);
    setError("");
    const result = await OrganizationRepository.setRejectMockLocation(next);
    setSaving(false);
    if (!result.success) {
      setError(humanizeBackendError(result.message, t) ?? t("rejectMockLocation.genericError"));
      return;
    }
    setReject(next);
  };

  if (loading) return null;

  return (
    <Card title={t("rejectMockLocation.label")}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)" }}>
        <HintText>{t("rejectMockLocation.hint")}</HintText>
        <Toggle checked={reject} onChange={handleChange} disabled={saving} label={t("rejectMockLocation.label")} />
      </div>
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
