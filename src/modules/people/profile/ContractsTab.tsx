import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText } from "lucide-react";

import Card from "../../../components/common/Card";
import Input from "../../../components/common/Input";
import Select from "../../../components/common/Select";
import Textarea from "../../../components/common/Textarea";
import Button from "../../../components/common/Button";
import Modal from "../../../components/common/Modal";
import EmptyState from "../../../components/common/EmptyState";
import ErrorText from "../../../components/common/ErrorText";
import StatusBadge from "../../../components/common/StatusBadge";
import humanizeBackendError from "../../../core/utils/humanizeBackendError";
import { formatDateOnly } from "../../../core/utils/formatDate";
import { useAuth } from "../../../core/context/AuthContext";
import EmployeeProfileRepository, { type ContractType, type EmployeeContract, type EmployeeProfile } from "../../../core/repositories/EmployeeProfileRepository";

const TYPES: ContractType[] = ["fixed_term", "open_ended", "temporary"];
const today = () => new Date().toISOString().slice(0, 10);

// HR suite feature 3: the person's contracts - type, dates, probation, the signed file. The current one
// is marked; one ending within 30 days says so.
export default function ContractsTab({ profile, onSaved }: { profile: EmployeeProfile; onSaved: () => void }) {
  const { t, i18n } = useTranslation("people");
  const { profile: me } = useAuth();
  const contracts = profile.contracts ?? [];
  const [editing, setEditing] = useState<Partial<EmployeeContract> & { file?: File | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const stateOf = (c: EmployeeContract) => {
    const now = today();
    if (c.startDate > now) return "upcoming";
    if (c.endDate && c.endDate < now) return "ended";
    if (c.endDate && new Date(c.endDate).getTime() - Date.now() < 30 * 86400000) return "ending";
    return "current";
  };

  const open = async (path: string) => {
    const url = await EmployeeProfileRepository.fileUrl(path);
    if (url) window.open(url, "_blank", "noopener");
  };

  const save = async () => {
    if (!editing || !me) return;
    setSaving(true);
    setError("");
    let filePath = editing.filePath ?? null;
    if (editing.file) {
      const ext = editing.file.name.split(".").pop() ?? "pdf";
      const uploaded = await EmployeeProfileRepository.uploadFile(me.organizationId, profile.header.id, editing.file, ext);
      if (uploaded.error || !uploaded.data) {
        setSaving(false);
        setError(humanizeBackendError(uploaded.error, t) ?? t("profile.uploadError"));
        return;
      }
      filePath = uploaded.data;
    }
    const result = await EmployeeProfileRepository.saveContract(editing.id ?? null, profile.header.id, {
      type: editing.type ?? "", start_date: editing.startDate ?? "", end_date: editing.endDate ?? "",
      probation_end_date: editing.probationEndDate ?? "", file_path: filePath, notes: editing.notes ?? "",
    });
    setSaving(false);
    if (result.error) {
      setError(humanizeBackendError(result.error, t) ?? t("profile.saveError"));
      return;
    }
    setEditing(null);
    onSaved();
  };

  return (
    <Card title={t("profile.tabs.contract")}>
      {contracts.length === 0 ? <EmptyState message={t("profile.contracts.empty")} /> : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-2)" }}>
          {contracts.map((c) => {
            const state = stateOf(c);
            return (
              <li key={c.id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--space-2)", padding: "var(--space-3)", border: "1px solid var(--border-light)", borderRadius: "var(--radius-md)" }}>
                <div style={{ flex: "1 1 14rem", minWidth: 0 }}>
                  <strong>{t(`profile.contracts.types.${c.type}`)}</strong>
                  <div style={{ color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>
                    {formatDateOnly(c.startDate, i18n.language)} → {c.endDate ? formatDateOnly(c.endDate, i18n.language) : t("profile.contracts.noEnd")}
                    {c.probationEndDate ? ` · ${t("profile.contracts.probationUntil", { date: formatDateOnly(c.probationEndDate, i18n.language) })}` : ""}
                  </div>
                </div>
                <StatusBadge status={state === "current" ? "active" : state === "ending" ? "pending" : state === "upcoming" ? "invited" : "expired"}>
                  {t(`profile.contracts.state.${state}`)}
                </StatusBadge>
                {c.filePath ? <Button size="sm" variant="ghost" onClick={() => void open(c.filePath!)}><FileText size={15} aria-hidden="true" /> {t("profile.contracts.view")}</Button> : null}
                {profile.canEdit ? <Button size="sm" variant="ghost" onClick={() => { setError(""); setEditing({ ...c, file: null }); }}>{t("profile.edit")}</Button> : null}
              </li>
            );
          })}
        </ul>
      )}
      {profile.canEdit ? (
        <div style={{ marginTop: "var(--space-3)" }}>
          <Button onClick={() => { setError(""); setEditing({ type: "open_ended", startDate: profile.header.hireDate ?? today(), file: null }); }}>{t("profile.contracts.add")}</Button>
        </div>
      ) : null}

      <Modal isOpen={Boolean(editing)} onClose={() => setEditing(null)} title={editing?.id ? t("profile.contracts.editTitle") : t("profile.contracts.add")}
        footer={<Button onClick={() => void save()} loading={saving}>{t("profile.save")}</Button>}>
        {editing ? (
          <div style={{ display: "grid", gap: "var(--space-2)" }}>
            <ErrorText>{error}</ErrorText>
            <Select label={t("profile.contracts.type")} name="contractType" value={editing.type ?? ""} onChange={(e) => setEditing({ ...editing, type: e.target.value as ContractType })}
              options={TYPES.map((x) => ({ value: x, label: t(`profile.contracts.types.${x}`) }))} />
            <Input label={t("profile.contracts.start")} name="contractStart" type="date" value={editing.startDate ?? ""} onChange={(e) => setEditing({ ...editing, startDate: e.target.value })} />
            <Input label={editing.type === "open_ended" ? t("profile.contracts.endOptional") : t("profile.contracts.end")} name="contractEnd" type="date"
              value={editing.endDate ?? ""} onChange={(e) => setEditing({ ...editing, endDate: e.target.value || null })} />
            <Input label={t("profile.contracts.probation")} name="contractProbation" type="date" value={editing.probationEndDate ?? ""} onChange={(e) => setEditing({ ...editing, probationEndDate: e.target.value || null })} />
            <label style={{ display: "grid", gap: 4, fontSize: "var(--font-sm)" }}>
              <span>{t("profile.contracts.file")}</span>
              <input type="file" accept="application/pdf,image/*" onChange={(e) => setEditing({ ...editing, file: e.target.files?.[0] ?? null })} />
            </label>
            <Textarea label={t("profile.contracts.notes")} name="contractNotes" value={editing.notes ?? ""} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} rows={2} />
          </div>
        ) : null}
      </Modal>
    </Card>
  );
}
