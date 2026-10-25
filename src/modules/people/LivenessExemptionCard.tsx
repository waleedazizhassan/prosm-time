import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import DatabaseManager from "../../core/database/DatabaseManager";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import Card from "../../components/common/Card";
import Toggle from "../../components/common/Toggle";
import Input from "../../components/common/Input";
import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";

// v2.3.43 step 11 (item 22): a person the liveness challenge does not suit
// (a disability, for example) is exempted by a manager, with the reason
// recorded (audited on the server).
export default function LivenessExemptionCard({ userId }: { userId: string }) {
  const { t } = useTranslation("people");
  const [exempt, setExempt] = useState(false);
  const [reason, setReason] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    DatabaseManager.getClient()
      .from("users")
      .select("liveness_exempt, liveness_exempt_reason")
      .eq("id", userId)
      .maybeSingle()
      .then(({ data }) => {
        setExempt(Boolean(data?.liveness_exempt));
        setReason(data?.liveness_exempt_reason ?? "");
        setLoaded(true);
      });
  }, [userId]);

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    const { error: saveError } = await DatabaseManager.getClient().rpc("set_prosm_time_liveness_exemption", { p_user_id: userId, p_exempt: exempt, p_reason: reason.trim() || null });
    setSaving(false);
    if (saveError) {
      setError(humanizeBackendError(saveError.message, t) ?? t("liveness.genericError"));
      return;
    }
    setSaved(true);
  };

  if (!loaded) return null;

  return (
    <Card title={t("liveness.title")}>
      <HintText small>{t("liveness.hint")}</HintText>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "var(--space-2) 0" }}>
        <span style={{ fontSize: "var(--font-sm)" }}>{t("liveness.exemptLabel")}</span>
        <Toggle checked={exempt} onChange={(value) => { setExempt(value); setSaved(false); }} disabled={saving} label={t("liveness.exemptLabel")} />
      </div>
      {exempt ? <Input label={t("liveness.reasonLabel")} name="livenessReason" value={reason} onChange={(event) => setReason(event.target.value)} disabled={saving} /> : null}
      <ErrorText>{error}</ErrorText>
      {saved ? <HintText small>{t("liveness.saved")}</HintText> : null}
      <Button size="sm" onClick={handleSave} loading={saving}>
        {t("liveness.save")}
      </Button>
    </Card>
  );
}
