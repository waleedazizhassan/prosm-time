import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Siren, X } from "lucide-react";

import Button from "../../components/common/Button";
import styles from "./SosAlertOverlay.module.css";

interface SosAlertOverlayProps {
  employeeName: string;
  onView: () => void;
  onDismiss: () => void;
}

// PROSM Time - user-directed: an SOS/emergency notification must not
// be "just a notification" - a full-screen siren takeover for whoever
// is watching (Admin/Owner - the only recipients notify_prosm_time_
// supervisors ever sends this to), paired with playSirenSound.ts's
// continuous audio. Dismiss just clears the takeover (the notification
// itself stays in the bell, unread until opened); "View" is the real
// action - it's how an admin actually gets to the emergency's exact
// GPS location, timestamp, employee and site (Emergency Log).
//
// Real bug fix, user-reported (screenshot showed the siren squeezed
// into a thin band instead of covering the screen): NotificationBell
// mounts inside Header, and Header.module.css sets its own
// backdrop-filter - which makes it the containing block for any
// `position: fixed` descendant (CSS spec: filter/backdrop-filter/
// transform on an ancestor does this), so the overlay was being
// clipped to the Header's own box instead of the viewport. Portaling
// straight to document.body escapes that entirely, regardless of
// where this component happens to be mounted.
export default function SosAlertOverlay({ employeeName, onView, onDismiss }: SosAlertOverlayProps) {
  const { t } = useTranslation("shell");

  return createPortal(
    <div className={styles.backdrop} role="alertdialog" aria-live="assertive" aria-label={t("sosOverlay.title")}>
      <div className={styles.panel}>
        <button type="button" className={styles.dismiss} onClick={onDismiss} aria-label={t("sosOverlay.dismissAction")}>
          <X size={18} />
        </button>

        <div className={styles.beacon}>
          <Siren size={56} />
        </div>

        <p className={styles.title}>{t("sosOverlay.title")}</p>
        <p className={styles.subtitle}>{t("sosOverlay.subtitle", { name: employeeName })}</p>

        <div className={styles.actions}>
          <Button variant="danger" onClick={onView}>
            {t("sosOverlay.viewAction")}
          </Button>
          <Button variant="ghost" onClick={onDismiss}>
            {t("sosOverlay.dismissAction")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
