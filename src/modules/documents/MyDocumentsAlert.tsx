import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Camera, FileWarning } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import usePlanFeatures from "../../core/hooks/usePlanFeatures";
import Button from "../../components/common/Button";
import DocumentsRepository, { type EmployeeDocument } from "../../core/repositories/DocumentsRepository";
import DocumentUploadQueue from "../../core/offline/DocumentUploadQueue";
import DocumentUploadModal, { type UploadTarget } from "./DocumentUploadModal";
import { NEEDS_ACTION, statusText } from "./documentUi";

const URGENCY: Record<string, number> = { expired: 0, rejected: 1, missing: 2, expiring: 3 };

// HR suite feature 2: on the employee's home, the one document that needs them most (expired, refused,
// missing, then expiring soon) with a button that opens the camera on it. Nothing shows when all is fine.
export default function MyDocumentsAlert() {
  const { t } = useTranslation("documents");
  const navigate = useNavigate();
  const { profile } = useAuth();
  const { allows } = usePlanFeatures(profile?.id);
  const enabled = allows("documents");
  const [docs, setDocs] = useState<EmployeeDocument[]>([]);
  const [queuedTypes, setQueuedTypes] = useState<string[]>([]);
  const [upload, setUpload] = useState<UploadTarget | null>(null);

  const load = useCallback(async () => {
    if (!profile?.id || !enabled) return;
    const r = await DocumentsRepository.listFor(profile.id);
    setDocs(r.data ?? []);
    setQueuedTypes((await DocumentUploadQueue.list(profile.id)).map((q) => q.typeId));
  }, [profile?.id, enabled]);

  useEffect(() => {
    void load();
    return DocumentUploadQueue.subscribe(() => void load());
  }, [load]);

  const due = docs
    .filter((d) => NEEDS_ACTION.includes(d.status) && !d.pendingId && !queuedTypes.includes(d.typeId))
    .sort((a, b) => (URGENCY[a.status] - URGENCY[b.status]) || ((a.daysLeft ?? 0) - (b.daysLeft ?? 0)));
  if (!profile || due.length === 0) return null;
  const first = due[0];
  const s = statusText(first.status, first.daysLeft);
  const danger = first.status !== "expiring";

  return (
    <div role="alert" style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap", padding: "var(--space-3)", marginBottom: "var(--space-3)",
      borderRadius: "var(--radius-md)", border: `1px solid ${danger ? "var(--status-danger-border, #fca5a5)" : "var(--status-warning-border, #fcd34d)"}`,
      background: danger ? "var(--status-danger-bg, #fef2f2)" : "var(--status-warning-bg, #fffbeb)", color: "var(--text-primary)" }}>
      <FileWarning size={20} aria-hidden="true" />
      <div style={{ flex: "1 1 12rem", minWidth: 0 }}>
        <strong>{first.typeName}: {t(s.key, { count: s.count })}</strong>
        {due.length > 1 ? (
          <button type="button" onClick={() => navigate("/me?tab=documents")} style={{ display: "block", border: 0, padding: 0, background: "none", color: "var(--text-link)", cursor: "pointer", font: "inherit", fontSize: "var(--font-sm)" }}>
            {t("alert.more", { count: due.length - 1 })}
          </button>
        ) : null}
      </div>
      <Button size="sm" onClick={() => setUpload({ userId: profile.id, typeId: first.typeId, typeName: first.typeName, hasExpiry: first.hasExpiry })}>
        <Camera size={15} aria-hidden="true" style={{ marginInlineEnd: 4 }} />{t("alert.photograph")}
      </Button>
      <DocumentUploadModal target={upload} onClose={() => setUpload(null)} onDone={() => { setUpload(null); void load(); }} />
    </div>
  );
}
