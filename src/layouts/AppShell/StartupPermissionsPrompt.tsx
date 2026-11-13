import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Bell, Camera, ChevronDown, MapPin, type LucideIcon } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import { answerStartupPermissions, readStartupPermissions } from "../../core/services/StartupPermissions";
import Modal from "../../components/common/Modal";
import Button from "../../components/common/Button";
import styles from "./StartupPermissionsPrompt.module.css";

// Owner 2026-10-28: "all the permissions at the start, each with what it is for". Shown once on the phone
// after signing in; Android's own dialogs follow "Continue" (location, camera, notifications), one after
// another. Owner 2026-11-13: the new look - each permission a small card with its icon and one short line;
// the full explanation opens under "Details".
const ITEMS: { key: "location" | "camera" | "notifications"; icon: LucideIcon }[] = [
  { key: "location", icon: MapPin },
  { key: "camera", icon: Camera },
  { key: "notifications", icon: Bell },
];

export default function StartupPermissionsPrompt() {
  const { profile } = useAuth();
  const { t } = useTranslation("shell");
  const [open, setOpen] = useState(() => readStartupPermissions() === "unknown");
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState<string | null>(null);
  if (!profile || !open) return null;

  const answer = async (value: "accepted" | "declined") => {
    setBusy(true);
    setOpen(false);
    await answerStartupPermissions(value);
  };

  return (
    <Modal
      isOpen
      onClose={() => void answer("declined")}
      title={t("startupPermissions.title")}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={() => void answer("declined")}>
            {t("startupPermissions.decline")}
          </Button>
          <Button disabled={busy} onClick={() => void answer("accepted")}>
            {t("startupPermissions.accept")}
          </Button>
        </>
      }
    >
      <p className={styles.intro}>{t("startupPermissions.intro")}</p>
      <ul className={styles.cards}>
        {ITEMS.map(({ key, icon: Icon }) => (
          <li key={key} className={styles.card}>
            <span className={styles.icon} aria-hidden="true"><Icon size={20} /></span>
            <div className={styles.text}>
              <strong className={styles.title}>{t(`startupPermissions.${key}.title`)}</strong>
              <span className={styles.short}>{t(`startupPermissions.${key}.short`)}</span>
              {more === key ? <span className={styles.body}>{t(`startupPermissions.${key}.body`)}</span> : null}
              <button type="button" className={styles.more} aria-expanded={more === key} onClick={() => setMore(more === key ? null : key)}>
                {t("startupPermissions.details")}
                <ChevronDown size={14} aria-hidden="true" className={more === key ? styles.turned : undefined} />
              </button>
            </div>
          </li>
        ))}
      </ul>
      <p className={styles.footer}>{t("startupPermissions.footer")}</p>
    </Modal>
  );
}
