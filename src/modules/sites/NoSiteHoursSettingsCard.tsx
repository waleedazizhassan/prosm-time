import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import OrganizationRepository, { type NoSiteHours } from "../../core/repositories/OrganizationRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import Card from "../../components/common/Card";
import Input from "../../components/common/Input";
import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import SuccessText from "../../components/common/SuccessText";

const EMPTY: NoSiteHours = { shiftStart: "", shiftEnd: "", overtimeStart: "", lateStart: "" };

// Owner 2026-11-10 ("under 'outside the sites' set the shift start and end, the overtime start and the
// late start - optional: left without hours is fine"): the hours a clock-in with no site follows. Each
// one may stay empty - then there is no lateness / overtime by the clock for those days, as before.
export default function NoSiteHoursSettingsCard() {
  const { t } = useTranslation("sites");
  const [hours, setHours] = useState<NoSiteHours>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    OrganizationRepository.getCurrentOrganization().then((result) => {
      if (result.success && result.data) setHours(result.data.noSiteHours ?? EMPTY);
      setLoading(false);
    });
  }, []);

  const change = (key: keyof NoSiteHours, value: string) => {
    setHours((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    const result = await OrganizationRepository.setNoSiteHours(hours);
    setSaving(false);
    if (!result.success) {
      setError(humanizeBackendError(result.message, t) ?? t("noSiteHours.genericError"));
      return;
    }
    setSaved(true);
  };

  if (loading) return null;

  return (
    <Card title={t("noSiteHours.title")}>
      <HintText>{t("noSiteHours.hint")}</HintText>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3)" }}>
        <Input label={t("form.shiftStartTimeLabel")} name="noSiteShiftStart" type="time" value={hours.shiftStart} onChange={(event) => change("shiftStart", event.target.value)} disabled={saving} />
        <Input label={t("form.shiftEndTimeLabel")} name="noSiteShiftEnd" type="time" value={hours.shiftEnd} onChange={(event) => change("shiftEnd", event.target.value)} disabled={saving} />
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3)" }}>
        <Input label={t("form.overtimeStartTimeLabel")} name="noSiteOvertimeStart" type="time" value={hours.overtimeStart} onChange={(event) => change("overtimeStart", event.target.value)} disabled={saving} />
        <Input label={t("form.lateDeductionStartTimeLabel")} name="noSiteLateStart" type="time" value={hours.lateStart} onChange={(event) => change("lateStart", event.target.value)} disabled={saving} />
      </div>
      <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)", flexWrap: "wrap" }}>
        <Button onClick={save} loading={saving}>{t("noSiteHours.saveAction")}</Button>
        <Button variant="ghost" onClick={() => { setHours(EMPTY); setSaved(false); }} disabled={saving}>{t("noSiteHours.clearAction")}</Button>
      </div>
      <ErrorText>{error}</ErrorText>
      {saved ? <SuccessText>{t("noSiteHours.saved")}</SuccessText> : null}
    </Card>
  );
}
