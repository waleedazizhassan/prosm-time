import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import Modal from "../../components/common/Modal";
import Button from "../../components/common/Button";
import { LocalStore, type MessageKind } from "./engine/localStore";
import { formatBytes } from "./engine/media";
import styles from "./StoragePanel.module.css";

const GROUPS: { key: string; kinds: MessageKind[]; color: string }[] = [
  { key: "messages", kinds: ["message", "site_broadcast", "photo_request", "missed", "meeting_invite"], color: "#2f7cf6" },
  { key: "images", kinds: ["image", "camera_photo"], color: "#22c55e" },
  { key: "video", kinds: [], color: "#ef4f4f" },
  { key: "files", kinds: ["file"], color: "#f2b33d" },
  { key: "voice", kinds: ["voice_note", "push_to_talk"], color: "#25c0e3" },
];

// PROSM Connect - the conversations' space on this device (owner 2026-11-13): how much each kind takes, and "clean up"
// by kind (the messages stay; their files go). Text is never removed by itself.
export default function StoragePanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("connect");
  const { profile } = useAuth();
  const [usage, setUsage] = useState<Record<string, number> | null>(null);

  const load = async () => {
    if (profile) setUsage(await LocalStore.usage(profile.id));
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const total = usage ? Object.values(usage).reduce((a, b) => a + b, 0) : 0;
  return (
    <Modal isOpen onClose={onClose} title={t("storage.title")} size="sm" footer={<Button variant="ghost" onClick={onClose}>{t("storage.close")}</Button>}>
      <p className={styles.total}>{t("storage.total", { size: formatBytes(total) })}</p>
      <div className={styles.bar} aria-hidden="true">
        {GROUPS.map((g) => <i key={g.key} style={{ background: g.color, width: total ? `${((usage?.[g.key] ?? 0) / total) * 100}%` : 0 }} />)}
      </div>
      <ul className={styles.list}>
        {GROUPS.map((g) => (
          <li key={g.key}>
            <span><i style={{ background: g.color }} /> {t(`storage.${g.key}`)}</span>
            <b>{formatBytes(usage?.[g.key] ?? 0)}</b>
            {g.kinds.length && g.key !== "messages" ? (
              <button type="button" aria-label={t("storage.clean", { what: t(`storage.${g.key}`) })} onClick={async () => { if (profile) { await LocalStore.clean(profile.id, g.kinds); await load(); } }}>
                <Trash2 size={14} />
              </button>
            ) : <span />}
          </li>
        ))}
      </ul>
      <p className={styles.note}>{t("storage.note")}</p>
    </Modal>
  );
}
