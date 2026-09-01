import { useTranslation } from "react-i18next";
import BrandMark from "../../components/common/BrandMark";
import styles from "./SplashScreen.module.css";

// PROSM Time WP-21/§31 - "Presentation/startup surface only - must
// not contain business logic." No props, no data fetching, no auth
// checks: it only ever renders brand/contact - AppRoutes' own
// RootRedirect decides WHEN to show it (while auth state is still
// resolving), never this component.
export default function SplashScreen() {
  const { t } = useTranslation("common");

  return (
    <div className={styles.page}>
      <div className={styles.center}>
        <BrandMark size={72} glow />
        <p className={styles.appName}>{t("appName")}</p>
        <p className={styles.tagline}>{t("splash.tagline")}</p>
      </div>
      <p className={styles.footer}>
        {t("splash.contactLabel")}{" "}
        <a href="mailto:info@prosm.com" className={styles.footerLink}>
          info@prosm.com
        </a>
      </p>
    </div>
  );
}
