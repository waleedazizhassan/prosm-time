// PROSM Time - "a newer version is available" notice (Finalization &
// Release Pipeline phase, user-directed).
//
// Web: "Update now" clears cached assets and reloads. Android/Windows: it
// opens the official download page. Nothing is ever installed silently.

import { useTranslation } from "react-i18next";

import { useUpdate } from "../../core/context/UpdateContext";
import { applyWebUpdate } from "../../core/update/updateChannel";
import styles from "./UpdateNotificationBanner.module.css";

export default function UpdateNotificationBanner() {
  const { t } = useTranslation("update");
  const { update, dismiss } = useUpdate();

  if (!update) return null;

  const onUpdateNow = () => {
    if (update.platform === "web" || !update.downloadUrl) {
      void applyWebUpdate();
      return;
    }
    window.open(update.downloadUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <div className={`${styles.banner} ${update.security ? styles.security : ""}`} role="status">
      <div className={styles.text}>
        <p className={styles.title}>{t("title")}</p>
        <p className={styles.versions}>
          {t("versions", { current: update.currentVersion, next: update.newVersion })}
        </p>
        <p className={styles.notes}>{update.notes ?? t("defaultNotes")}</p>
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={onUpdateNow}>
          {t("action.updateNow")}
        </button>
        <button type="button" className={styles.secondary} onClick={dismiss}>
          {t("action.later")}
        </button>
      </div>
    </div>
  );
}
