import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import DatabaseManager from "../../core/database/DatabaseManager";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import Card from "../../components/common/Card";
import Toggle from "../../components/common/Toggle";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";

// v2.3.43 step 12 (item 24): a field worker moves around for work, so leaving
// the site never prompts them or clocks them out (audited on the server).
export default function FieldWorkerCard({ userId }: { userId: string }) {
  const { t } = useTranslation("people");
  const [fieldWorker, setFieldWorker] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    DatabaseManager.getClient()
      .from("users")
      .select("field_worker")
      .eq("id", userId)
      .maybeSingle()
      .then(({ data }) => setFieldWorker(Boolean(data?.field_worker)));
  }, [userId]);

  const handleChange = async (value: boolean) => {
    setSaving(true);
    setError("");
    const { error: saveError } = await DatabaseManager.getClient().rpc("set_prosm_time_field_worker", { p_user_id: userId, p_field_worker: value });
    setSaving(false);
    if (saveError) {
      setError(humanizeBackendError(saveError.message, t) ?? t("fieldWorker.genericError"));
      return;
    }
    setFieldWorker(value);
  };

  if (fieldWorker === null) return null;

  return (
    <Card title={t("fieldWorker.title")}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)" }}>
        <HintText small>{t("fieldWorker.hint")}</HintText>
        <Toggle checked={fieldWorker} onChange={(value) => void handleChange(value)} disabled={saving} label={t("fieldWorker.title")} />
      </div>
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
