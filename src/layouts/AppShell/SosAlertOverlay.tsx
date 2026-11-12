import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { MapPin, Siren, VolumeX, X } from "lucide-react";

import Button from "../../components/common/Button";
import styles from "./SosAlertOverlay.module.css";

interface SosAlertOverlayProps {
  employeeName: string;
  /** the emergency log - only for whoever may open it (attendance.view or the owner) */
  onView: (() => void) | null;
  onShowLocation: () => void;
  locating: boolean;
  /** the location could not be read */
  noLocation: boolean;
  onSilence: () => void;
  silenced: boolean;
  onDismiss: () => void;
}

// PROSM Time - user-directed: an SOS/emergency notification must not
// be "just a notification" - a full-screen siren takeover for whoever
// is watching, paired with playSirenSound.ts's continuous audio.
// Recipients: every org supervisor (notify_prosm_time_supervisors -
// Owner/Admin or exceptions.manage/attendance.clock_out_on_behalf
// holders) AND, since 20260908170000 (user-reported: SOS must also
// reach co-workers physically at the same site, not just Admin/Owner),
// every other user currently clocked in at the same site -
// trigger_prosm_time_sos_alert notifies both sets. Dismiss just clears
// the takeover (the notification itself stays in the bell, unread
// until opened); "View" is the real action - it's how anyone who sees
// this actually gets to the emergency's exact GPS location, timestamp,
// employee and site (Emergency Log).
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
// Owner 2026-11-12: "the alarm reaches the employee with 'view the emergency log', though that is the
// managers' - give it 'show the location' and 'silence'". Everyone gets the location (opened on the map) and
// silence; the emergency log button shows only to whoever may open it.
export default function SosAlertOverlay({ employeeName, onView, onShowLocation, locating, noLocation, onSilence, silenced, onDismiss }: SosAlertOverlayProps) {
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
          <Button variant="danger" onClick={onShowLocation} loading={locating}>
            <MapPin size={16} aria-hidden="true" /> {t("sosOverlay.locationAction")}
          </Button>
          {silenced ? (
            <Button variant="ghost" onClick={onDismiss}>
              {t("sosOverlay.dismissAction")}
            </Button>
          ) : (
            <Button variant="ghost" onClick={onSilence}>
              <VolumeX size={16} aria-hidden="true" /> {t("sosOverlay.silenceAction")}
            </Button>
          )}
        </div>
        {noLocation ? <p className={styles.subtitle}>{t("sosOverlay.noLocation")}</p> : null}
        {onView ? (
          <Button variant="ghost" size="sm" onClick={onView}>
            {t("sosOverlay.viewAction")}
          </Button>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
