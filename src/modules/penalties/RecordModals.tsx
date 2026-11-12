import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Camera } from "lucide-react";

import Modal from "../../components/common/Modal";
import Button from "../../components/common/Button";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Textarea from "../../components/common/Textarea";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import { useAuth } from "../../core/context/AuthContext";
import EmployeeRepository from "../../core/repositories/EmployeeRepository";
import EmployeeProfileRepository from "../../core/repositories/EmployeeProfileRepository";
import PenaltiesRepository, { type AmountType } from "../../core/repositories/PenaltiesRepository";
import { violationName } from "./penaltyUi";

const today = () => new Date().toLocaleDateString("en-CA");

function usePeople(fixedUserId?: string) {
  const { profile } = useAuth();
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (fixedUserId) return;
    void EmployeeRepository.listOrganizationMembers().then((r) =>
      setPeople((r.data ?? []).filter((m) => m.isActive && !m.isOwner && m.id !== profile?.id).map((m) => ({ id: m.id, name: m.fullName }))));
  }, [fixedUserId, profile?.id]);
  return people;
}

// HR suite feature 1: a manager records a violation by hand (with a photo, from the phone); the bylaw
// in force decides the occurrence and the penalty.
export function RecordViolationModal({ open, userId, onClose, onDone }: { open: boolean; userId?: string; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation("penalties");
  const { profile } = useAuth();
  const people = usePeople(userId);
  const [types, setTypes] = useState<{ id: string; name: string | null; templateKey: string | null }[] | null>(null);
  const [active, setActive] = useState(true);
  const [person, setPerson] = useState(userId ?? "");
  const [type, setType] = useState("");
  const [day, setDay] = useState(today());
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setPerson(userId ?? "");
    setType("");
    setDay(today());
    setNote("");
    setFile(null);
    setError("");
    void PenaltiesRepository.manualTypes().then((r) => {
      setActive(Boolean(r.data?.active));
      setTypes(r.data?.types ?? []);
    });
  }, [open, userId]);

  const send = async () => {
    if (!profile) return;
    if (!person || !type) return setError(t("record.choose"));
    setBusy(true);
    setError("");
    let evidence: string | null = null;
    if (file) {
      const up = await EmployeeProfileRepository.uploadFile(profile.organizationId, person, file, file.name.split(".").pop() ?? "jpg", "evidence");
      if (up.error) {
        setBusy(false);
        return setError(humanizeBackendError(up.error, t) ?? t("record.photoError"));
      }
      evidence = up.data;
    }
    const r = await PenaltiesRepository.record(person, type, day, note.trim(), evidence, crypto.randomUUID());
    setBusy(false);
    if (r.error) return setError(humanizeBackendError(r.error, t) ?? t("actionError"));
    onDone();
  };

  return (
    <Modal isOpen={open} onClose={onClose} title={t("record.title")} size="sm"
      footer={<Button fullWidth loading={busy} disabled={!active} onClick={() => void send()}>{t("record.send")}</Button>}>
      {!active ? <HintText>{t("record.notActive")}</HintText> : (
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          <ErrorText>{error}</ErrorText>
          {!userId ? (
            <Select label={t("record.person")} name="violationPerson" value={person} onChange={(e) => setPerson(e.target.value)}
              options={[{ value: "", label: t("choose") }, ...people.map((p) => ({ value: p.id, label: p.name }))]} />
          ) : null}
          <Select label={t("record.violation")} name="violationType" value={type} onChange={(e) => setType(e.target.value)}
            options={[{ value: "", label: t("choose") }, ...(types ?? []).map((x) => ({ value: x.id, label: violationName(t, x) }))]} />
          {types && types.length === 0 ? <HintText small>{t("record.noManual")}</HintText> : null}
          <Input label={t("record.date")} name="violationDate" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          <Textarea label={t("record.what")} name="violationNote" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
          <label style={{ display: "flex", gap: 8, alignItems: "center", padding: "var(--space-2)", border: "1px dashed var(--border-light)", borderRadius: "var(--radius-md)", cursor: "pointer" }}>
            <Camera size={18} aria-hidden="true" />
            <span>{file ? file.name : t("record.photo")}</span>
            <input type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <HintText small>{t("record.hint")}</HintText>
        </div>
      )}
    </Modal>
  );
}

// HR suite feature 1: an incentive by hand - it goes through the company's approval levels, then payroll
export function GrantIncentiveModal({ open, userId, onClose, onDone }: { open: boolean; userId?: string; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation("penalties");
  const people = usePeople(userId);
  const [person, setPerson] = useState(userId ?? "");
  const [amountType, setAmountType] = useState<AmountType>("amount");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setPerson(userId ?? "");
    setValue("");
    setReason("");
    setError("");
  }, [open, userId]);

  const send = async () => {
    if (!person) return setError(t("record.choose"));
    setBusy(true);
    setError("");
    const r = await PenaltiesRepository.grantIncentive(person, { amountType, value, reason: reason.trim(), clientRef: crypto.randomUUID() });
    setBusy(false);
    if (r.error) return setError(humanizeBackendError(r.error, t) ?? t("actionError"));
    onDone();
  };

  return (
    <Modal isOpen={open} onClose={onClose} title={t("incentive.title")} size="sm"
      footer={<Button fullWidth loading={busy} onClick={() => void send()}>{t("incentive.send")}</Button>}>
      <div style={{ display: "grid", gap: "var(--space-2)" }}>
        <ErrorText>{error}</ErrorText>
        {!userId ? (
          <Select label={t("record.person")} name="incentivePerson" value={person} onChange={(e) => setPerson(e.target.value)}
            options={[{ value: "", label: t("choose") }, ...people.map((p) => ({ value: p.id, label: p.name }))]} />
        ) : null}
        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 9rem" }}>
            <Select label={t("incentive.kind")} name="incentiveKind" value={amountType} onChange={(e) => setAmountType(e.target.value as AmountType)}
              options={(["amount", "days", "percent"] as const).map((k) => ({ value: k, label: t(`incentive.kinds.${k}`) }))} />
          </div>
          <div style={{ flex: "1 1 7rem" }}>
            <Input label={t("incentive.value")} name="incentiveValue" type="number" value={value} onChange={(e) => setValue(e.target.value)} />
          </div>
        </div>
        <Textarea label={t("incentive.reason")} name="incentiveReason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
        <HintText small>{t("incentive.hint")}</HintText>
      </div>
    </Modal>
  );
}
