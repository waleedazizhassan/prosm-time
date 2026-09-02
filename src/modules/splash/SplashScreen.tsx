import { useTranslation } from "react-i18next";
import BrandMark from "../../components/common/BrandMark";
import splashPhoto from "../../assets/splash-photo.png";
import styles from "./SplashScreen.module.css";

// PROSM Time WP-21/§31 - "Presentation/startup surface only - must
// not contain business logic." No props, no data fetching, no auth
// checks: it only ever renders brand/contact - AppRoutes' own
// RootRedirect decides WHEN to show it (while auth state is still
// resolving), never this component.
//
// § live UX review, user-directed - "the PROSM Time image with the
// person should be the splash image." An explicit, current
// instruction to use the supplied photo literally, overriding this
// screen's own earlier abstracted-glow-only treatment - the dark
// gradient overlay stays (readability for the text on top), now
// layered over the real photo instead of a plain color.
export default function SplashScreen() {
  const { t } = useTranslation("common");

  return (
    <div className={styles.page} style={{ backgroundImage: `linear-gradient(120deg, rgba(11,18,32,0.94) 30%, rgba(11,18,32,0.55) 75%), url(${splashPhoto})` }}>
      <div className={styles.center}>
        <BrandMark size={72} glow />
        <p className={styles.appName}>{t("appName")}</p>
        <p className={styles.tagline}>{t("splash.tagline")}</p>
      </div>
      <p className={styles.footer}>
        {t("splash.contactLabel")}{" "}
        <a href="mailto:info@prosm.net" className={styles.footerLink}>
          info@prosm.net
        </a>
      </p>
    </div>
  );
}
