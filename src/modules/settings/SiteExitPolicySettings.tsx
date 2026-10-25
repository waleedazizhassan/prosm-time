import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import DatabaseManager from "../../core/database/DatabaseManager";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Toggle from "../../components/common/Toggle";
import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";

type Policy = "OFF" | "PROMPT" | "AUTO";

// v2.3.43 step 12 (item 24): what happens when someone leaves the site with
// the shift still open. Off by default; the Owner (sites.manage_exit_policy)
// decides; audited on the server. A field site is never prompted.
export default function SiteExitPolicySettings({ siteId }: { siteId: string }) {
  const { t } = useTranslation("sites");
  const [policy, setPolicy] = useState<Policy>("OFF");
  const [minutes, setMinutes] = useState("10");
  const [fieldSite, setFieldSite] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    DatabaseManager.getClient()
      .from("sites")
      .select("exit_policy, exit_auto_minutes, field_site")
      .eq("id", siteId)
      .maybeSingle()
      .then(({ data }) => {
        if (!data) return;
        setPolicy((data.exit_policy as Policy) ?? "OFF");
        setMinutes(String(data.exit_auto_minutes ?? 10));
        setFieldSite(Boolean(data.field_site));
      });
  }, [siteId]);

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    const { error: saveError } = await DatabaseManager.getClient().rpc("set_prosm_time_site_exit_policy", {
      p_site_id: siteId,
      p_policy: policy,
      p_auto_minutes: Number(minutes) || 10,
      p_field_site: fieldSite,
    });
    setSaving(false);
    if (saveError) {
      setError(humanizeBackendError(saveError.message, t) ?? t("exitPolicy.genericError"));
      return;
    }
    setSaved(true);
  };

  return (
    <div style={{ borderTop: "1px solid var(--border-light)", marginTop: "var(--space-3)", paddingTop: "var(--space-3)" }}>
      <h3 style={{ margin: "0 0 var(--space-2)", fontSize: "var(--font-sm)" }}>{t("exitPolicy.title")}</h3>
      <HintText small>{t("exitPolicy.hint")}</HintText>
      <Select
        label={t("exitPolicy.label")}
        name="exitPolicy"
        value={policy}
        onChange={(event) => { setPolicy(event.target.value as Policy); setSaved(false); }}
        options={(["OFF", "PROMPT", "AUTO"] as Policy[]).map((value) => ({ value, label: t(`exitPolicy.option.${value}`) }))}
      />
      {policy === "AUTO" ? <Input label={t("exitPolicy.minutesLabel")} name="exitMinutes" type="number" value={minutes} onChange={(event) => setMinutes(event.target.value)} /> : null}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "var(--space-2) 0" }}>
        <span style={{ fontSize: "var(--font-sm)" }}>{t("exitPolicy.fieldSiteLabel")}</span>
        <Toggle checked={fieldSite} onChange={(value) => { setFieldSite(value); setSaved(false); }} label={t("exitPolicy.fieldSiteLabel")} />
      </div>
      <ErrorText>{error}</ErrorText>
      {saved ? <HintText small>{t("exitPolicy.saved")}</HintText> : null}
      <Button size="sm" onClick={handleSave} loading={saving}>
        {t("exitPolicy.save")}
      </Button>
    </div>
  );
}
