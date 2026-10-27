import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "../../components/common/Button";
import DateRange from "../../components/common/DateRange";
import ErrorText from "../../components/common/ErrorText";
import Input from "../../components/common/Input";
import Modal from "../../components/common/Modal";
import Select from "../../components/common/Select";
import Textarea from "../../components/common/Textarea";
import LeaveRepository, { type LeaveTypeSetting } from "../../core/repositories/LeaveRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import leaveTypeLabel from "./leaveTypeLabel";

const localDay = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

// Owner 2026-10-27: someone was absent without a request (they asked by
// phone) - the manager records the leave for them, past days included; it is
// approved at once, the absence becomes leave and the timesheet follows.
export default function GrantLeaveModal({
  person,
  onClose,
  onGranted,
}: {
  person: { id: string; name: string } | null;
  onClose: () => void;
  onGranted: (message: string) => void;
}) {
  const { t } = useTranslation("leave");
  const { t: tCommon } = useTranslation("common");
  const [types, setTypes] = useState<LeaveTypeSetting[]>([]);
  const [leaveType, setLeaveType] = useState("annual");
  const [startDate, setStartDate] = useState(localDay());
  const [endDate, setEndDate] = useState(localDay());
  const [notes, setNotes] = useState("");
  const [deduction, setDeduction] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!person) return;
    setStartDate(localDay());
    setEndDate(localDay());
    setNotes("");
    setDeduction("");
    setError("");
    void LeaveRepository.listTypes().then((result) => {
      const active = (result.data ?? []).filter((type) => type.isActive);
      setTypes(active);
      if (active.length > 0 && !active.some((type) => type.key === "annual")) setLeaveType(active[0].key);
    });
  }, [person]);

  if (!person) return null;
  const unpaid = leaveType === "unpaid";

  const save = async () => {
    setSaving(true);
    setError("");
    const result = await LeaveRepository.grant(person.id, leaveType, startDate, endDate < startDate ? startDate : endDate, notes, unpaid ? Number(deduction) : null);
    setSaving(false);
    if (!result.success || !result.data) {
      setError(humanizeBackendError(result.message, tCommon) ?? t("grant.error"));
      return;
    }
    onGranted(result.data.timesheetsToReopen > 0 ? t("grant.doneReopen", { name: person.name, count: result.data.timesheetsToReopen }) : t("grant.done", { name: person.name }));
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t("grant.title", { name: person.name })}
      footer={
        <Button onClick={save} loading={saving} disabled={!startDate || (unpaid && deduction === "")}>
          {t("grant.action")}
        </Button>
      }
    >
      <p style={{ margin: "0 0 var(--space-3)", fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{t("grant.hint")}</p>
      <Select
        label={t("grant.typeLabel")}
        name="grantLeaveType"
        value={leaveType}
        onChange={(event) => setLeaveType(event.target.value)}
        options={(types.length > 0 ? types : [{ key: "annual", name: "" } as LeaveTypeSetting]).map((type) => ({ value: type.key, label: leaveTypeLabel(t, type.key, type.name) }))}
      />
      <DateRange>
        <Input label={t("startDateLabel")} name="grantLeaveStart" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
        <Input label={t("endDateLabel")} name="grantLeaveEnd" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
      </DateRange>
      {unpaid ? <Input label={t("grant.deductionLabel")} name="grantLeaveDeduction" type="number" value={deduction} onChange={(event) => setDeduction(event.target.value)} helperText={t("grant.deductionHint")} /> : null}
      <Textarea label={t("grant.notesLabel")} name="grantLeaveNotes" value={notes} onChange={(event) => setNotes(event.target.value)} />
      <ErrorText>{error}</ErrorText>
    </Modal>
  );
}
