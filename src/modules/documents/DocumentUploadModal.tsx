import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Camera } from "lucide-react";

import Modal from "../../components/common/Modal";
import Input from "../../components/common/Input";
import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import { useAuth } from "../../core/context/AuthContext";
import DocumentsRepository from "../../core/repositories/DocumentsRepository";
import EmployeeProfileRepository from "../../core/repositories/EmployeeProfileRepository";
import DocumentUploadQueue from "../../core/offline/DocumentUploadQueue";

export interface UploadTarget {
  userId: string;
  /** null: a new document added from the person's file (owner 2026-11-12) - its name is typed */
  typeId: string | null;
  typeName: string;
  hasExpiry: boolean;
  /** names already used in the organisation, suggested while typing */
  knownNames?: string[];
}

// HR suite feature 2: upload or renew one document - photograph it (the phone's camera opens) or pick a
// file, then its number and dates. Without a connection it is kept on the phone and sent later.
export default function DocumentUploadModal({ target, onClose, onDone }: { target: UploadTarget | null; onClose: () => void; onDone: (queued: boolean) => void }) {
  const { t } = useTranslation("documents");
  const { profile } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [number, setNumber] = useState("");
  const [issue, setIssue] = useState("");
  const [expiry, setExpiry] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [withExpiry, setWithExpiry] = useState(true);
  // owner 2026-11-12: a new document can be required from every employee (and stop clock-in once expired)
  const [requiredForAll, setRequiredForAll] = useState(false);
  const [blockClockIn, setBlockClockIn] = useState(false);
  const isNew = Boolean(target && !target.typeId);
  const needsExpiry = isNew ? withExpiry : Boolean(target?.hasExpiry);

  const reset = () => {
    setFile(null);
    setNumber("");
    setIssue("");
    setExpiry("");
    setError("");
    setName("");
    setWithExpiry(true);
    setRequiredForAll(false);
    setBlockClockIn(false);
  };

  const send = async () => {
    if (!target || !profile) return;
    if (isNew && !name.trim()) return setError(t("upload.needName"));
    if (!file) return setError(t("upload.needFile"));
    if (!/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(file.type) || file.size > 10 * 1024 * 1024) return setError(t("upload.badFile"));
    if (needsExpiry && !expiry) return setError(t("upload.needExpiry"));
    if (issue && expiry && expiry < issue) return setError(t("upload.endBeforeStart"));
    setBusy(true);
    setError("");
    // a new document needs its kind first (online only)
    let typeId = target.typeId;
    let typeName = target.typeName;
    if (!typeId) {
      const made = await DocumentsRepository.ensureTypeFor(target.userId, name.trim(), withExpiry);
      if (made.error || !made.data) {
        setBusy(false);
        return setError(humanizeBackendError(made.error, t) ?? t("upload.error"));
      }
      typeId = made.data.id;
      typeName = made.data.name;
      if (made.data.hasExpiry && !expiry) {
        setBusy(false);
        return setError(t("upload.needExpiry"));
      }
    }
    const keep = async () => {
      try {
        await DocumentUploadQueue.enqueue({
          organizationId: profile.organizationId, userId: target.userId, typeId: typeId!, typeName,
          documentNumber: number.trim() || null, issueDate: issue || null, expiryDate: expiry || null, file, fileName: file.name, submittedBy: profile.id,
        });
      } catch {
        setBusy(false);
        return setError(t("upload.error"));
      }
      setBusy(false);
      reset();
      onDone(true);
    };
    if (typeof navigator !== "undefined" && navigator.onLine === false) return keep();
    const ext = file.name.split(".").pop() ?? "jpg";
    const uploaded = await EmployeeProfileRepository.uploadFile(profile.organizationId, target.userId, file, ext);
    if (uploaded.error || !uploaded.data) {
      if (/fetch|network|Failed/i.test(uploaded.error ?? "")) return keep();
      setBusy(false);
      return setError(humanizeBackendError(uploaded.error, t) ?? t("upload.error"));
    }
    const sent = await DocumentsRepository.submit(target.userId, typeId, {
      file_path: uploaded.data, document_number: number.trim() || null, issue_date: issue || null, expiry_date: expiry || null, client_ref: crypto.randomUUID(),
    });
    setBusy(false);
    if (sent.error) return setError(humanizeBackendError(sent.error, t) ?? t("upload.error"));
    if (isNew && requiredForAll) {
      const req = await DocumentsRepository.setRequired(typeId, true, withExpiry && blockClockIn);
      if (req.error) return setError(humanizeBackendError(req.error, t) ?? t("upload.error"));
    }
    reset();
    onDone(false);
  };

  return (
    <Modal isOpen={Boolean(target)} onClose={() => { reset(); onClose(); }} title={target ? (isNew ? t("addDocument") : t("upload.title", { name: target.typeName })) : ""} size="sm"
      footer={<Button fullWidth onClick={() => void send()} loading={busy}>{t("upload.send")}</Button>}>
      <div style={{ display: "grid", gap: "var(--space-2)" }}>
        <ErrorText>{error}</ErrorText>
        {isNew ? (
          <>
            <Input label={t("upload.name")} name="docName" value={name} onChange={(e) => setName(e.target.value)} required list="doc-known-names" />
            <datalist id="doc-known-names">{(target?.knownNames ?? []).map((n) => <option key={n} value={n} />)}</datalist>
            <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--font-sm)" }}>
              <input type="checkbox" checked={withExpiry} onChange={(e) => setWithExpiry(e.target.checked)} /> {t("upload.hasExpiry")}
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--font-sm)" }}>
              <input type="checkbox" checked={requiredForAll} onChange={(e) => setRequiredForAll(e.target.checked)} /> {t("upload.requiredForAll")}
            </label>
            {requiredForAll && withExpiry ? (
              <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--font-sm)", paddingInlineStart: "var(--space-4)" }}>
                <input type="checkbox" checked={blockClockIn} onChange={(e) => setBlockClockIn(e.target.checked)} /> {t("upload.blockClockIn")}
              </label>
            ) : null}
          </>
        ) : null}
        <label style={{ display: "grid", justifyItems: "center", gap: 8, padding: "var(--space-4)", border: "2px dashed var(--border-light)", borderRadius: "var(--radius-md)", cursor: "pointer", textAlign: "center" }}>
          <Camera size={28} aria-hidden="true" color="var(--brand-primary)" />
          <strong>{file ? file.name : t("upload.photo")}</strong>
          <small style={{ color: "var(--text-secondary)" }}>{t("upload.photoHint")}</small>
          <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" capture="environment" style={{ display: "none" }}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        </label>
        <Input label={t("upload.number")} name="docNumber" value={number} onChange={(e) => setNumber(e.target.value)} />
        <Input label={t("upload.issue")} name="docIssue" type="date" value={issue} onChange={(e) => setIssue(e.target.value)} />
        {needsExpiry ? <Input label={t("upload.expiry")} name="docExpiry" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} required /> : null}
        {needsExpiry ? <HintText small>{t("upload.expiryHint")}</HintText> : null}
        <HintText small>{t("upload.offlineHint")}</HintText>
      </div>
    </Modal>
  );
}
