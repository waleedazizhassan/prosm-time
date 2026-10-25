import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import DatabaseManager from "../../core/database/DatabaseManager";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";

type Mode = "OFF" | "RANDOM" | "ALWAYS";

// v2.3.43 step 11 (item 22): a site's liveness challenge and the age a
// clock-in photo may have. The Owner (sites.manage_integrity) changes it; the
// change is audited on the server.
export default function SiteIntegritySettings({ siteId }: { siteId: string }) {
  const { t } = useTranslation("sites");
  const [mode, setMode] = useState<Mode>("OFF");
  const [percent, setPercent] = useState("25");
  const [maxAge, setMaxAge] = useState("120");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    DatabaseManager.getClient()
      .from("sites")
      .select("liveness_mode, liveness_random_percent, capture_max_age_seconds")
      .eq("id", siteId)
      .maybeSingle()
      .then(({ data }) => {
        if (!data) return;
        setMode((data.liveness_mode as Mode) ?? "OFF");
        setPercent(String(data.liveness_random_percent ?? 25));
        setMaxAge(String(data.capture_max_age_seconds ?? 120));
      });
  }, [siteId]);

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    const { error: saveError } = await DatabaseManager.getClient().rpc("set_prosm_time_site_integrity", {
      p_site_id: siteId,
      p_liveness_mode: mode,
      p_random_percent: Number(percent) || 25,
      p_max_age_seconds: Number(maxAge) || 120,
    });
    setSaving(false);
    if (saveError) {
      setError(humanizeBackendError(saveError.message, t) ?? t("integrity.genericError"));
      return;
    }
    setSaved(true);
  };

  return (
    <div style={{ borderTop: "1px solid var(--border-light)", marginTop: "var(--space-3)", paddingTop: "var(--space-3)" }}>
      <h3 style={{ margin: "0 0 var(--space-2)", fontSize: "var(--font-sm)" }}>{t("integrity.title")}</h3>
      <HintText small>{t("integrity.hint")}</HintText>
      <Select
        label={t("integrity.modeLabel")}
        name="livenessMode"
        value={mode}
        onChange={(event) => { setMode(event.target.value as Mode); setSaved(false); }}
        options={(["OFF", "RANDOM", "ALWAYS"] as Mode[]).map((value) => ({ value, label: t(`integrity.mode.${value}`) }))}
      />
      {mode === "RANDOM" ? <Input label={t("integrity.percentLabel")} name="livenessPercent" type="number" value={percent} onChange={(event) => setPercent(event.target.value)} /> : null}
      <Input label={t("integrity.maxAgeLabel")} name="captureMaxAge" type="number" value={maxAge} onChange={(event) => setMaxAge(event.target.value)} />
      <ErrorText>{error}</ErrorText>
      {saved ? <HintText small>{t("integrity.saved")}</HintText> : null}
      <Button size="sm" onClick={handleSave} loading={saving}>
        {t("integrity.save")}
      </Button>
    </div>
  );
}
