import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import AttendanceControlRepository from "../../core/repositories/AttendanceControlRepository";
import type { ShiftTemplate } from "../../core/repositories/ShiftRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import Modal from "../../components/common/Modal";
import Button from "../../components/common/Button";
import Input from "../../components/common/Input";
import Toggle from "../../components/common/Toggle";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";

// v2.3.43 step 6 (item 23 d): a shift template's break rules - paid or
// unpaid (unpaid breaks come off the worked time), a maximum (minutes over
// it are unpaid) and an automatic deduction when no break was taken.
export default function BreakRulesModal({ template, onClose, onSaved }: { template: ShiftTemplate | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation("schedule");
  const [paid, setPaid] = useState(true);
  const [max, setMax] = useState("");
  const [auto, setAuto] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!template) return;
    setPaid(template.breakPaid);
    setMax(template.breakMaxMinutes === null ? "" : String(template.breakMaxMinutes));
    setAuto(template.breakAutoDeductMinutes === null ? "" : String(template.breakAutoDeductMinutes));
    setError("");
  }, [template]);

  const handleSave = async () => {
    if (!template) return;
    setSaving(true);
    setError("");
    const result = await AttendanceControlRepository.setBreakRules(template.id, paid, max ? Number(max) : null, auto ? Number(auto) : null);
    setSaving(false);
    if (!result.success) {
      setError(humanizeBackendError(result.message, t) ?? t("breakRules.genericError"));
      return;
    }
    onSaved();
    onClose();
  };

  return (
    <Modal
      isOpen={Boolean(template)}
      onClose={onClose}
      title={template ? t("breakRules.title", { name: template.name }) : ""}
      footer={
        <Button onClick={handleSave} loading={saving}>
          {t("breakRules.save")}
        </Button>
      }
    >
      <HintText small>{t("breakRules.hint")}</HintText>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "var(--space-2) 0" }}>
        <span style={{ fontSize: "var(--font-sm)" }}>{t("breakRules.paidLabel")}</span>
        <Toggle checked={paid} onChange={setPaid} label={t("breakRules.paidLabel")} />
      </div>
      <Input label={t("breakRules.maxLabel")} name="breakMax" type="number" value={max} onChange={(event) => setMax(event.target.value)} />
      <Input label={t("breakRules.autoLabel")} name="breakAuto" type="number" value={auto} onChange={(event) => setAuto(event.target.value)} />
      <ErrorText>{error}</ErrorText>
    </Modal>
  );
}
