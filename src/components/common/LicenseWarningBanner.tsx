// PROSM Time - the persistent, professional license warning (License
// Enforcement & Installation Identity phase, user-directed).
//
// It shows the days left in the server-tracked grace period and a clear
// activation path. It is a notice, not a control: hiding it changes nothing
// about what the server allows.

import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { useLicense } from "../../core/context/LicenseContext";
import { licenseNotice } from "../../core/license/licenseState";
import styles from "./LicenseWarningBanner.module.css";

export default function LicenseWarningBanner() {
  const { t } = useTranslation("license");
  const { license } = useLicense();

  const notice = licenseNotice(license);
  if (!notice) return null;

  return (
    <div className={`${styles.banner} ${notice.tone === "critical" ? styles.critical : styles.warning}`} role="status">
      <p className={styles.message}>
        {t(notice.messageKey, { days: notice.daysRemaining ?? 0 })}
      </p>
      {notice.actionKey === "action.activate" ? (
        <Link className={styles.action} to="/activate">
          {t("action.activate")}
        </Link>
      ) : notice.actionKey ? (
        <span className={styles.action}>{t(notice.actionKey)}</span>
      ) : null}
    </div>
  );
}
