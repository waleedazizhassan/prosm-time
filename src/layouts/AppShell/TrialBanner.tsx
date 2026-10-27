import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Hourglass, X } from "lucide-react";

import useTrialStatus from "../../modules/activation/useTrialStatus";
import { formatDateOnly } from "../../core/utils/formatDate";
import styles from "./InstallationStatusBanner.module.css";

const HIDDEN_KEY = "prosm_time_trial_banner_hidden";
// the banner comes back by itself for the last days of the trial
const RETURNS_AT_DAYS = 3;

const readHidden = () => {
  try {
    return localStorage.getItem(HIDDEN_KEY);
  } catch {
    return null;
  }
};

// Demo (owner 2026-09-29): during the 30-day trial every screen shows how long is left.
// Owner 2026-10-26: it can be closed (the page footer keeps the count); it
// returns once a day in the last three days.
export default function TrialBanner() {
  const { t, i18n } = useTranslation("shell");
  const { status } = useTrialStatus(true);
  const today = new Date().toISOString().slice(0, 10);
  const [hidden, setHidden] = useState(readHidden());
  // owner 2026-10-27: licence matters are the Owner's
  if (!status?.isTrial || status.locked || !status.isOwner) return null;
  const closing = (status.daysLeft ?? 0) <= RETURNS_AT_DAYS;
  if (hidden && (!closing || hidden === today)) return null;
  const close = () => {
    try {
      localStorage.setItem(HIDDEN_KEY, today);
    } catch {
      // storage unavailable: closed for this visit
    }
    setHidden(today);
  };
  return (
    <div className={`${styles.banner} ${styles.grace}`}>
      <Hourglass size={16} />
      <span style={{ flex: 1 }}>
        {t("trial.banner", { count: status.daysLeft ?? 0, date: status.expiresAt ? formatDateOnly(status.expiresAt, i18n.language) : "" })}{" "}
        <a href="mailto:sales@prosm.net">sales@prosm.net</a>
      </span>
      <button type="button" className={styles.close} onClick={close} aria-label={t("trial.close")} title={t("trial.close")}>
        <X size={16} />
      </button>
    </div>
  );
}
