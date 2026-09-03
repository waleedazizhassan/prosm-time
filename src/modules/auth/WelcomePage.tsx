import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import AuthHeader from "../../components/common/AuthHeader";
import Button from "../../components/common/Button";
import authPhoto from "../../assets/splash-photo.png";
import { APP_VERSION } from "../../core/appVersion";
import { LANGUAGES } from "../../i18n/languages";
import pageStyles from "../../components/common/AuthLayout.module.css";
import styles from "./WelcomePage.module.css";

// PROSM Time - § live UX review, user-directed:
// - Desktop (>=861px): "no need for a card here, the header alone is
//   enough" - AuthHeader already carries the Sign in / Create
//   organization entry points, so this is just the full-page photo
//   behind it, no card, no duplicate CTAs (styles.mobileCard is
//   display:none at this width).
// - Mobile (<=860px): AuthHeader itself is hidden there (it has no
//   mobile treatment - see AuthLayout.module.css), so phones would
//   otherwise land on a blank photo with no way to go anywhere. The
//   mobile-only card below (WelcomePage.module.css) gives them the
//   same two entry points AuthHeader gives desktop.
export default function WelcomePage() {
  const { t, i18n } = useTranslation("auth");
  const navigate = useNavigate();

  return (
    <div className={pageStyles.page} style={{ "--auth-photo": `url(${authPhoto})` } as CSSProperties}>
      <AuthHeader showVersion={false} />

      <div className={styles.mobileCard}>
        <div className={styles.photoBand} style={{ backgroundImage: `url(${authPhoto})` }} />
        <div className={styles.body}>
          {/* § live UX review, user-directed - mobile has no other way
              to change language (AuthHeader's own selector is
              desktop-only), and the default language is now always
              English on first load - give phones an explicit switch. */}
          <select
            className={styles.mobileLanguageSelect}
            value={i18n.language}
            onChange={(event) => i18n.changeLanguage(event.target.value)}
            aria-label={t("authHeader.languageAriaLabel")}
          >
            {LANGUAGES.map((language) => (
              <option key={language.code} value={language.code}>
                {language.nativeLabel}
              </option>
            ))}
          </select>

          <h1 className={styles.title}>{t("welcome.title")}</h1>
          <p className={styles.subtitle}>{t("welcome.subtitle")}</p>

          <Button fullWidth onClick={() => navigate("/login")}>
            {t("login.submitAction")}
          </Button>
          <button type="button" className={pageStyles.secondaryButton} style={{ marginTop: "var(--space-3)" }} onClick={() => navigate("/activate")}>
            {t("authHeader.createOrganization")}
          </button>
        </div>
      </div>

      <span className={styles.versionFooter}>{t("common:versionLabel", { version: APP_VERSION })}</span>
    </div>
  );
}
