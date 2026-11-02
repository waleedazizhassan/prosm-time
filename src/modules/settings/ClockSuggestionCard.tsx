import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { requireSupabaseClient } from "../../core/api/supabaseClient";
import OrganizationRepository from "../../core/repositories/OrganizationRepository";
import Card from "../../components/common/Card";
import ErrorText from "../../components/common/ErrorText";

// Plan stage 8.4: off by default. Nothing is recorded without the person's tap.
export default function ClockSuggestionCard() {
  const { t } = useTranslation("settings");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void OrganizationRepository.getCurrentOrganization().then((result) => {
      if (result.success && result.data) setEnabled(result.data.suggestClockIn);
    });
  }, []);

  if (enabled === null) return null;

  const change = async (next: boolean) => {
    setError("");
    setEnabled(next);
    const { error: failed } = await requireSupabaseClient().rpc("set_prosm_time_clock_suggestion", { p_enabled: next });
    if (failed) {
      setEnabled(!next);
      setError(t("clockSuggestion.failed"));
    }
  };

  return (
    <Card title={t("clockSuggestion.title")} subtitle={t("clockSuggestion.subtitle")}>
      <label style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
        <input type="checkbox" checked={enabled} onChange={(event) => void change(event.target.checked)} />
        {t("clockSuggestion.label")}
      </label>
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
