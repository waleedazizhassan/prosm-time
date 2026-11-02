import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import ShiftExtrasRepository from "../../core/repositories/ShiftExtrasRepository";
import Button from "../../components/common/Button";
import Card from "../../components/common/Card";
import ErrorText from "../../components/common/ErrorText";
import Textarea from "../../components/common/Textarea";

// docs/IDEAS.md 6: the site's end-of-shift checklist, one item per line. Empty = none.
export default function ChecklistSettingsCard({ siteId }: { siteId: string }) {
  const { t } = useTranslation("schedule");
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setSaved(false);
    void ShiftExtrasRepository.siteChecklist(siteId).then((items) => setText(items.map((item) => item.label).join("\n")));
  }, [siteId]);

  const save = async () => {
    setError("");
    setSaved(false);
    const labels = text.split("\n").map((line) => line.trim()).filter(Boolean);
    if (labels.length > 20) {
      setError(t("checklist.tooMany"));
      return;
    }
    if (await ShiftExtrasRepository.setSiteChecklist(siteId, labels)) setSaved(true);
    else setError(t("checklist.failed"));
  };

  return (
    <Card title={t("checklist.title")} subtitle={t("checklist.subtitle")}>
      <Textarea label={t("checklist.label")} name="siteChecklist" value={text} onChange={(event) => setText(event.target.value)} rows={4} />
      <ErrorText>{error}</ErrorText>
      {saved ? <p style={{ color: "var(--status-success-text)", fontSize: "var(--font-sm)" }}>{t("checklist.saved")}</p> : null}
      <Button onClick={save}>{t("checklist.save")}</Button>
    </Card>
  );
}
