import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import AttendanceControlRepository, { EMPTY_POLICY, type OvertimeApprovalMode, type OvertimePolicy } from "../../core/repositories/AttendanceControlRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import Card from "../../components/common/Card";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";

type NumberField = "minOvertimeMinutes" | "minLateMinutes" | "maxDailyOvertimeMinutes" | "multiplierNormal" | "multiplierNight" | "multiplierWeeklyRest" | "multiplierPublicHoliday";
const NUMBER_FIELDS: NumberField[] = ["minOvertimeMinutes", "minLateMinutes", "maxDailyOvertimeMinutes", "multiplierNormal", "multiplierNight", "multiplierWeeklyRest", "multiplierPublicHoliday"];

// v2.3.43 step 6 (item 23): the organisation's overtime policy (the Owner's):
// automatic or after a manager's approval (the default), thresholds, a daily
// cap, the multipliers per kind of day (1.0 = today's behaviour) and the night
// window. Blank = the default.
export default function OvertimePolicySettingsCard() {
  const { t } = useTranslation("settings");
  const [policy, setPolicy] = useState<OvertimePolicy | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    AttendanceControlRepository.getOrganizationPolicy().then((result) => {
      const loaded = result.data ?? { ...EMPTY_POLICY };
      setPolicy(loaded);
      setDraft(Object.fromEntries(Object.entries(loaded).map(([key, value]) => [key, value === null ? "" : String(value)])));
    });
  }, []);

  const handleSave = async () => {
    const next: OvertimePolicy = {
      ...EMPTY_POLICY,
      approvalMode: (draft.approvalMode || null) as OvertimeApprovalMode | null,
      nightStart: draft.nightStart || null,
      nightEnd: draft.nightEnd || null,
    };
    for (const field of NUMBER_FIELDS) {
      const value = draft[field];
      if (value === undefined || value === "") continue;
      if (Number.isNaN(Number(value)) || Number(value) < 0) {
        setError(t("overtimePolicy.invalid"));
        return;
      }
      next[field] = Number(value);
    }
    setSaving(true);
    setError("");
    setSaved(false);
    const result = await AttendanceControlRepository.setPolicy(null, null, next);
    setSaving(false);
    if (!result.success) {
      setError(humanizeBackendError(result.message, t) ?? t("overtimePolicy.genericError"));
      return;
    }
    setPolicy(next);
    setSaved(true);
  };

  if (!policy) return null;
  const set = (key: string, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };

  return (
    <Card title={t("overtimePolicy.title")}>
      <HintText small>{t("overtimePolicy.hint")}</HintText>
      <Select
        label={t("overtimePolicy.approvalModeLabel")}
        name="overtimeApprovalMode"
        value={draft.approvalMode ?? ""}
        onChange={(event) => set("approvalMode", event.target.value)}
        options={[
          { value: "", label: t("overtimePolicy.mode.default") },
          { value: "approval", label: t("overtimePolicy.mode.approval") },
          { value: "automatic", label: t("overtimePolicy.mode.automatic") },
        ]}
      />
      <div style={{ display: "grid", gap: "var(--space-2)", gridTemplateColumns: "repeat(auto-fit, minmax(13rem, 1fr))" }}>
        {NUMBER_FIELDS.map((field) => (
          <Input key={field} label={t(`overtimePolicy.field.${field}`)} name={`overtime-${field}`} type="number" value={draft[field] ?? ""} placeholder={t(`overtimePolicy.placeholder.${field}`)} onChange={(event) => set(field, event.target.value)} />
        ))}
        <Input label={t("overtimePolicy.field.nightStart")} name="overtime-nightStart" type="time" value={draft.nightStart ?? ""} onChange={(event) => set("nightStart", event.target.value)} />
        <Input label={t("overtimePolicy.field.nightEnd")} name="overtime-nightEnd" type="time" value={draft.nightEnd ?? ""} onChange={(event) => set("nightEnd", event.target.value)} />
      </div>
      <ErrorText>{error}</ErrorText>
      {saved ? <HintText small>{t("overtimePolicy.saved")}</HintText> : null}
      <Button onClick={handleSave} loading={saving}>
        {t("overtimePolicy.save")}
      </Button>
    </Card>
  );
}
