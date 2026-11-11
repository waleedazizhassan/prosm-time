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
  typeId: string;
  typeName: string;
  hasExpiry: boolean;
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

  const reset = () => {
    setFile(null);
    setNumber("");
    setIssue("");
    setExpiry("");
    setError("");
  };

  const send = async () => {
    if (!target || !profile) return;
    if (!file) return setError(t("upload.needFile"));
    if (target.hasExpiry && !expiry) return setError(t("upload.needExpiry"));
    setBusy(true);
    setError("");
    const keep = async () => {
      await DocumentUploadQueue.enqueue({
        organizationId: profile.organizationId, userId: target.userId, typeId: target.typeId, typeName: target.typeName,
        documentNumber: number.trim() || null, issueDate: issue || null, expiryDate: expiry || null, file, fileName: file.name,
      });
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
    const sent = await DocumentsRepository.submit(target.userId, target.typeId, {
      file_path: uploaded.data, document_number: number.trim() || null, issue_date: issue || null, expiry_date: expiry || null, client_ref: crypto.randomUUID(),
    });
    setBusy(false);
    if (sent.error) return setError(humanizeBackendError(sent.error, t) ?? t("upload.error"));
    reset();
    onDone(false);
  };

  return (
    <Modal isOpen={Boolean(target)} onClose={() => { reset(); onClose(); }} title={target ? t("upload.title", { name: target.typeName }) : ""} size="sm"
      footer={<Button fullWidth onClick={() => void send()} loading={busy}>{t("upload.send")}</Button>}>
      <div style={{ display: "grid", gap: "var(--space-2)" }}>
        <ErrorText>{error}</ErrorText>
        <label style={{ display: "grid", justifyItems: "center", gap: 8, padding: "var(--space-4)", border: "2px dashed var(--border-light)", borderRadius: "var(--radius-md)", cursor: "pointer", textAlign: "center" }}>
          <Camera size={28} aria-hidden="true" color="var(--brand-primary)" />
          <strong>{file ? file.name : t("upload.photo")}</strong>
          <small style={{ color: "var(--text-secondary)" }}>{t("upload.photoHint")}</small>
          <input type="file" accept="image/*,application/pdf" capture="environment" style={{ display: "none" }}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        </label>
        <Input label={t("upload.number")} name="docNumber" value={number} onChange={(e) => setNumber(e.target.value)} />
        <Input label={t("upload.issue")} name="docIssue" type="date" value={issue} onChange={(e) => setIssue(e.target.value)} />
        {target?.hasExpiry ? <Input label={t("upload.expiry")} name="docExpiry" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} required /> : null}
        <HintText small>{t("upload.offlineHint")}</HintText>
      </div>
    </Modal>
  );
}
