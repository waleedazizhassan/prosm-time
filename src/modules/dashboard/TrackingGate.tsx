import { useTranslation } from "react-i18next";
import { BatteryCharging, Bell, MapPin, ShieldCheck } from "lucide-react";

import Modal from "../../components/common/Modal";
import Button from "../../components/common/Button";
import { answerStartupPermissions } from "../../core/services/StartupPermissions";
import { openBatterySettings, openTrackingAppSettings } from "../../core/services/ShiftTrackingNative";
import styles from "./TrackingGate.module.css";

export type TrackingNeed = "consent" | "location" | "notifications" | "battery";

// Owner 2026-11-11 ("make running in the background mandatory, like WhatsApp"): on the Android app a
// shift starts only when the phone can follow it - the person agreed, location and notifications are
// allowed, and the phone does not put PROSM Time to sleep to save battery. Each missing step has its
// button; "Check again" continues to the clock-in once everything is ready.
// Owner 2026-11-13: the battery exemption is no longer demanded - it is shown apart, marked optional, with
// what it is for; the shift starts without it.
export default function TrackingGate({ missing, optional = [], onCheck, onClose }: { missing: TrackingNeed[]; optional?: TrackingNeed[]; onCheck: () => void; onClose: () => void }) {
  const { t } = useTranslation("dashboard");
  const icon = { consent: ShieldCheck, location: MapPin, notifications: Bell, battery: BatteryCharging };
  const act = async (need: TrackingNeed) => {
    if (need === "consent" || need === "location") await answerStartupPermissions("accepted");
    else if (need === "notifications") await openTrackingAppSettings();
    else await openBatterySettings();
  };
  return (
    <Modal isOpen onClose={onClose} title={t("attendance.trackingGate.title")} size="sm"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t("attendance.trackingGate.later")}</Button>
          <Button onClick={onCheck}>{t("attendance.trackingGate.check")}</Button>
        </>
      )}>
      <p className={styles.lead}>{t("attendance.trackingGate.lead")}</p>
      <ul className={styles.list}>
        {[...missing, ...optional].map((need) => {
          const isOptional = optional.includes(need) && !missing.includes(need);
          const Icon = icon[need];
          return (
            <li key={need} className={styles.item}>
              <Icon size={18} aria-hidden="true" className={styles.icon} />
              <span className={styles.text}>
                <strong>{t(`attendance.trackingGate.${need}.title`)}{isOptional ? <span className={styles.optional}>{t("attendance.trackingGate.optional")}</span> : null}</strong>
                <small>{t(isOptional ? `attendance.trackingGate.${need}.why` : `attendance.trackingGate.${need}.hint`)}</small>
              </span>
              <Button size="sm" variant={isOptional ? "ghost" : "primary"} onClick={() => void act(need)}>{t(`attendance.trackingGate.${need}.action`)}</Button>
            </li>
          );
        })}
      </ul>
      <p className={styles.note}>{t("attendance.trackingGate.light")}</p>
    </Modal>
  );
}
