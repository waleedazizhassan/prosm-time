// PROSM Time - the persistent, professional license notice (License
// Enforcement & Installation Identity phase, user-directed).
//
// It states the situation without accusing anyone, shows the days left in
// the server-tracked grace period and its end date, and offers activation
// or a sales contact. It is a notice, not a control: hiding it changes
// nothing about what the server allows.

import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { useLicense } from "../../core/context/LicenseContext";
import { licenseNotice } from "../../core/license/licenseState";
import styles from "./LicenseWarningBanner.module.css";

const SALES_URL = "https://prosm.net/#contact";

export default function LicenseWarningBanner() {
  const { t, i18n } = useTranslation("license");
  const { license } = useLicense();

  const notice = licenseNotice(license);
  if (!notice) return null;

  const graceEndsAt = license.graceEndsAt
    ? new Date(license.graceEndsAt).toLocaleDateString(i18n.language)
    : null;

  return (
    <section
      className={`${styles.banner} ${notice.tone === "critical" ? styles.critical : styles.warning}`}
      role="status"
    >
      <div className={styles.text}>
        <p className={styles.title}>{t("title")}</p>
        <p className={styles.message}>{t(notice.messageKey, { days: notice.daysRemaining ?? 0 })}</p>
        {notice.daysRemaining !== null && graceEndsAt ? (
          <p className={styles.detail}>
            {t("detail.grace", { days: notice.daysRemaining, date: graceEndsAt })}
          </p>
        ) : null}
      </div>

      <div className={styles.actions}>
        {notice.actionKey === "action.activate" ? (
          <Link className={styles.primary} to="/activate">
            {t("action.activate")}
          </Link>
        ) : null}
        <a className={styles.secondary} href={SALES_URL} target="_blank" rel="noopener noreferrer">
          {t("action.sales")}
        </a>
      </div>
    </section>
  );
}
