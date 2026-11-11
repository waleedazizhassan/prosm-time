import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, FileText } from "lucide-react";

import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import Modal from "../../components/common/Modal";
import Textarea from "../../components/common/Textarea";
import StatusBadge from "../../components/common/StatusBadge";
import EmptyState from "../../components/common/EmptyState";
import LoadingState from "../../components/common/LoadingState";
import ErrorText from "../../components/common/ErrorText";
import SuccessText from "../../components/common/SuccessText";
import HintText from "../../components/common/HintText";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import { formatDateOnly } from "../../core/utils/formatDate";
import DocumentsRepository, { type EmployeeDocument } from "../../core/repositories/DocumentsRepository";
import EmployeeProfileRepository, { type EmployeeProfile } from "../../core/repositories/EmployeeProfileRepository";
import DocumentUploadQueue, { type QueuedDocument } from "../../core/offline/DocumentUploadQueue";
import DocumentUploadModal, { type UploadTarget } from "./DocumentUploadModal";
import { NEEDS_ACTION, STATUS_BADGE, statusText } from "./documentUi";

// HR suite feature 2: the person's documents in their file - what is required, its number, expiry and
// state; upload or renew (the person or a personnel manager), review an upload, remind the person; older
// versions kept below each one. Uploads made offline show as "waiting to send".
export default function ProfileDocumentsPanel({ profile, onChanged }: { profile: EmployeeProfile; onChanged: () => void }) {
  const { t, i18n } = useTranslation("documents");
  const userId = profile.header.id;
  const isHr = profile.access === "full";
  const [docs, setDocs] = useState<EmployeeDocument[] | null>(null);
  const [queued, setQueued] = useState<QueuedDocument[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [upload, setUpload] = useState<UploadTarget | null>(null);
  const [review, setReview] = useState<EmployeeDocument | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState("");
  const [openArchive, setOpenArchive] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await DocumentsRepository.listFor(userId);
    if (r.error) setError(humanizeBackendError(r.error, t) ?? t("loadError"));
    setDocs(r.data ?? []);
    setQueued(await DocumentUploadQueue.list(userId));
  }, [userId, t]);

  useEffect(() => {
    void load();
    return DocumentUploadQueue.subscribe(() => void load());
  }, [load]);

  const view = async (path: string | null) => {
    if (!path) return;
    const url = await EmployeeProfileRepository.fileUrl(path);
    if (url) window.open(url, "_blank", "noopener");
  };

  const act = async (key: string, task: () => Promise<{ error: string | null }>, done: string) => {
    setBusy(key);
    setError("");
    setNotice("");
    const r = await task();
    setBusy("");
    if (r.error) return setError(humanizeBackendError(r.error, t) ?? t("actionError"));
    setNotice(done);
    await load();
    onChanged();
  };

  if (!docs) return <LoadingState />;
  return (
    <Card title={t("tabTitle")}>
      <ErrorText>{error}</ErrorText>
      {notice ? <SuccessText>{notice}</SuccessText> : null}
      {queued.length > 0 ? <HintText>{t("queued", { count: queued.length })}</HintText> : null}
      {docs.length === 0 ? <EmptyState message={isHr ? t("emptyHr") : t("empty")} /> : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid" }}>
          {docs.map((d) => {
            const s = statusText(d.status, d.daysLeft);
            const waiting = queued.some((q) => q.typeId === d.typeId);
            return (
              <li key={d.id} style={{ padding: "var(--space-3) 0", borderBottom: "1px solid var(--border-light)" }}>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--space-2)" }}>
                  <div style={{ flex: "1 1 13rem", minWidth: 0 }}>
                    <strong style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <FileText size={15} aria-hidden="true" /> {d.typeName}
                      {d.isMandatory ? <Check size={13} aria-label={t("mandatory")} /> : null}
                    </strong>
                    <div style={{ color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>
                      {[d.documentNumber, d.expiryDate ? t("expires", { date: formatDateOnly(d.expiryDate, i18n.language) }) : d.hasFile && !d.hasExpiry ? t("noExpiry") : null].filter(Boolean).join(" · ") || "—"}
                    </div>
                    {d.status === "rejected" && d.rejectionReason ? <div style={{ color: "var(--status-danger-text, #b91c1c)", fontSize: "var(--font-sm)" }}>{t("rejectedBecause", { reason: d.rejectionReason })}</div> : null}
                  </div>
                  <StatusBadge status={waiting ? "invited" : STATUS_BADGE[d.status]}>{waiting ? t("status.waitingToSend") : t(s.key, { count: s.count })}</StatusBadge>
                  {d.pendingId && !waiting ? <StatusBadge status="invited">{t("status.pending_review")}</StatusBadge> : null}
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {d.hasFile ? <Button size="sm" variant="ghost" onClick={() => void view(d.filePath)}>{t("view")}</Button> : null}
                    {isHr && d.pending ? <Button size="sm" onClick={() => { setReason(""); setReview(d); }}>{t("review")}</Button> : null}
                    <Button size="sm" variant={NEEDS_ACTION.includes(d.status) ? "primary" : "ghost"}
                      onClick={() => setUpload({ userId, typeId: d.typeId, typeName: d.typeName, hasExpiry: d.hasExpiry })}>
                      {d.hasFile ? t("renew") : t("upload.action")}
                    </Button>
                    {isHr && NEEDS_ACTION.includes(d.status) ? (
                      <Button size="sm" variant="ghost" loading={busy === `r${d.id}`} onClick={() => void act(`r${d.id}`, () => DocumentsRepository.remind(d.id), t("reminded"))}>{t("remind")}</Button>
                    ) : null}
                    {d.archived.length > 0 ? <Button size="sm" variant="ghost" onClick={() => setOpenArchive(openArchive === d.id ? null : d.id)}>{t("archive", { count: d.archived.length })}</Button> : null}
                  </div>
                </div>
                {openArchive === d.id ? (
                  <ul style={{ listStyle: "none", margin: "var(--space-2) 0 0", paddingInlineStart: "var(--space-4)", fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
                    {d.archived.map((a) => (
                      <li key={a.id} style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
                        <span>{[a.documentNumber, a.expiryDate ? formatDateOnly(a.expiryDate, i18n.language) : null, a.uploadedAt ? formatDateOnly(a.uploadedAt, i18n.language) : null].filter(Boolean).join(" · ")}</span>
                        {a.filePath ? <button type="button" onClick={() => void view(a.filePath)} style={{ border: 0, background: "none", color: "var(--text-link)", cursor: "pointer", font: "inherit" }}>{t("view")}</button> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <DocumentUploadModal target={upload} onClose={() => setUpload(null)}
        onDone={(wasQueued) => { setUpload(null); setNotice(wasQueued ? t("savedOffline") : isHr ? t("uploadedHr") : t("uploadedSelf")); void load(); onChanged(); }} />

      <Modal isOpen={Boolean(review)} onClose={() => setReview(null)} title={review ? t("reviewTitle", { name: review.typeName }) : ""} size="sm"
        footer={(
          <>
            <Button variant="danger" loading={busy === "reject"} onClick={() => review?.pending && void act("reject", () => DocumentsRepository.review(review.pending!.id, false, reason.trim()), t("rejected")).then(() => setReview(null))}>{t("reject")}</Button>
            <Button loading={busy === "accept"} onClick={() => review?.pending && void act("accept", () => DocumentsRepository.review(review.pending!.id, true, null), t("accepted")).then(() => setReview(null))}>{t("accept")}</Button>
          </>
        )}>
        {review?.pending ? (
          <div style={{ display: "grid", gap: "var(--space-2)" }}>
            <p style={{ margin: 0 }}>{[review.pending.documentNumber, review.pending.expiryDate ? t("expires", { date: formatDateOnly(review.pending.expiryDate, i18n.language) }) : null].filter(Boolean).join(" · ")}</p>
            <Button variant="ghost" onClick={() => void view(review.pending!.filePath)}>{t("viewUpload")}</Button>
            <Textarea label={t("rejectReason")} name="rejectReason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          </div>
        ) : null}
      </Modal>
    </Card>
  );
}
