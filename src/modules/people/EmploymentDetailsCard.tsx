import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import LeaveRepository from "../../core/repositories/LeaveRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import Card from "../../components/common/Card";
import Input from "../../components/common/Input";
import Toggle from "../../components/common/Toggle";
import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";

// v2.3.43 step 7 (item 25): the hire date (leave entitlements follow the
// years of service) and the special-needs entitlement (45 days of annual
// leave by default). Saved on the server with employees.edit; audited.
export default function EmploymentDetailsCard({ userId, canEdit }: { userId: string; canEdit: boolean }) {
  const { t } = useTranslation("people");
  const [hireDate, setHireDate] = useState("");
  const [specialNeeds, setSpecialNeeds] = useState(false);
  const [serviceYears, setServiceYears] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    LeaveRepository.getEmploymentDetails(userId).then((result) => {
      if (result.success && result.data) {
        setHireDate(result.data.hireDate ?? "");
        setSpecialNeeds(Boolean(result.data.specialNeeds));
        setServiceYears(result.data.serviceYears);
      }
      setLoaded(true);
    });
  }, [userId]);

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    const result = await LeaveRepository.setEmploymentDetails(userId, hireDate || null, specialNeeds);
    setSaving(false);
    if (!result.success) {
      setError(humanizeBackendError(result.message, t) ?? t("employment.genericError"));
      return;
    }
    setSaved(true);
  };

  if (!loaded) return null;

  return (
    <Card title={t("employment.title")}>
      <HintText small>{t("employment.hint")}</HintText>
      {serviceYears !== null ? <p style={{ fontSize: "var(--font-sm)", margin: "0 0 var(--space-2)" }}>{t("employment.serviceYears", { years: serviceYears })}</p> : null}
      <Input label={t("employment.hireDate")} name="hireDate" type="date" value={hireDate} onChange={(event) => { setHireDate(event.target.value); setSaved(false); }} disabled={!canEdit || saving} />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "var(--space-2) 0" }}>
        <span style={{ fontSize: "var(--font-sm)" }}>{t("employment.specialNeeds")}</span>
        <Toggle checked={specialNeeds} onChange={(value) => { setSpecialNeeds(value); setSaved(false); }} disabled={!canEdit || saving} label={t("employment.specialNeeds")} />
      </div>
      <ErrorText>{error}</ErrorText>
      {saved ? <HintText small>{t("employment.saved")}</HintText> : null}
      {canEdit ? (
        <Button onClick={handleSave} loading={saving}>
          {t("employment.save")}
        </Button>
      ) : null}
    </Card>
  );
}
