import { useTranslation } from "react-i18next";
import { Hourglass } from "lucide-react";

import useTrialStatus from "../../modules/activation/useTrialStatus";
import { formatDateOnly } from "../../core/utils/formatDate";
import styles from "./InstallationStatusBanner.module.css";

// Demo (owner 2026-09-29): during the 30-day trial every screen shows how long is left.
export default function TrialBanner() {
  const { t, i18n } = useTranslation("shell");
  const { status } = useTrialStatus(true);
  if (!status?.isTrial || status.locked) return null;
  return (
    <div className={`${styles.banner} ${styles.grace}`}>
      <Hourglass size={16} />
      <span>
        {t("trial.banner", { count: status.daysLeft ?? 0, date: status.expiresAt ? formatDateOnly(status.expiresAt, i18n.language) : "" })}{" "}
        <a href="mailto:sales@prosm.net">sales@prosm.net</a>
      </span>
    </div>
  );
}
