import { useTranslation } from "react-i18next";
import { Link2, Paperclip } from "lucide-react";

import AnnouncementRepository, { type AnnouncementAttachment } from "../../core/repositories/AnnouncementRepository";
import { announcementError, fileSize } from "./announcementsUi";

// opens a link or a file of an announcement; a file gets a 5-minute link from the server first
export function useOpenAttachment(onError: (message: string) => void) {
  const { t } = useTranslation("announcements");
  return async (item: AnnouncementAttachment) => {
    if (item.kind === "link" && item.url) {
      window.open(item.url, "_blank", "noopener,noreferrer");
      return;
    }
    const tab = window.open("", "_blank");
    const result = await AnnouncementRepository.fileUrl(item.id);
    if (result.error || !result.data?.url) {
      tab?.close();
      onError(announcementError(result.error, t));
      return;
    }
    if (tab) tab.location.href = result.data.url;
    else window.location.href = result.data.url;
  };
}

export function AttachmentList({ items, onOpen }: { items: AnnouncementAttachment[]; onOpen: (item: AnnouncementAttachment) => void }) {
  const { t } = useTranslation("announcements");
  if (items.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: "var(--space-1)", marginTop: "var(--space-2)" }}>
      {items.map((item) => (
        <button key={item.id} type="button" onClick={() => onOpen(item)}
          style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-2)", textAlign: "start", background: "var(--surface-muted, transparent)", border: "1px solid var(--border-light)", borderRadius: 8, padding: "8px 10px", cursor: "pointer", color: "inherit", font: "inherit" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>{item.kind === "link" ? <Link2 size={16} aria-hidden="true" /> : <Paperclip size={16} aria-hidden="true" />}{item.title}</span>
          <span style={{ color: "var(--text-secondary)", fontSize: "var(--font-xs)" }}>{item.kind === "link" ? t("attachments.link") : fileSize(item.fileSize)}</span>
        </button>
      ))}
    </div>
  );
}

