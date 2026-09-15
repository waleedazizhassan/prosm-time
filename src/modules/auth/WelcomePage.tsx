import { useState, type CSSProperties, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Sun, Moon } from "lucide-react";

import AuthHeader from "../../components/common/AuthHeader";
import Button from "../../components/common/Button";
import authPhoto from "../../assets/splash-photo.webp";
import { APP_VERSION } from "../../core/appVersion";
import { LANGUAGES } from "../../i18n/languages";
import { useTheme } from "../../core/context/ThemeContext";
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
//
// § user-directed, 2026-09-15 - "clicking the marketing image on the
// Welcome page should hide whatever card/UI is showing" (all 3 PROSM
// products). uiHidden toggles AuthHeader (desktop) and the mobile
// card's own body/controls off, leaving just the raw photo - a click
// anywhere on the plain background (never a real child control) flips
// it back. The `event.target === event.currentTarget` guard is what
// keeps this from swallowing clicks on the real buttons/select/etc.
// nested inside these same elements.
export default function WelcomePage() {
  const { t, i18n } = useTranslation("auth");
  const navigate = useNavigate();
  const { resolvedTheme, setTheme } = useTheme();
  const [uiHidden, setUiHidden] = useState(false);

  const toggleUiOnBackgroundClick = (event: MouseEvent) => {
    if (event.target === event.currentTarget) {
      setUiHidden((current) => !current);
    }
  };

  return (
    <div className={pageStyles.page} style={{ "--auth-photo": `url(${authPhoto})` } as CSSProperties} onClick={toggleUiOnBackgroundClick}>
      {uiHidden ? null : <AuthHeader showVersion={false} />}

      <div className={styles.mobileCard}>
        <div className={styles.photoBand} style={{ backgroundImage: `url(${authPhoto})` }} onClick={toggleUiOnBackgroundClick}>
          {/* § user-directed, 2026-09-13 - moved off the card body
              (where it pushed the title down) to float over the photo's
              own top-right corner instead, with a theme toggle right
              beside it - mobile has no other way to reach either
              control (AuthHeader's own versions are desktop-only). */}
          {uiHidden ? null : (
            <div className={styles.topControls}>
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
              <button
                type="button"
                className={styles.themeToggle}
                onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
                aria-label={t("authHeader.themeToggleAriaLabel")}
              >
                {resolvedTheme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
              </button>
            </div>
          )}
        </div>
        {uiHidden ? null : (
          <div className={styles.body}>
            <h1 className={styles.title}>{t("welcome.title")}</h1>
            <p className={styles.subtitle}>{t("welcome.subtitle")}</p>

            <Button fullWidth onClick={() => navigate("/login")}>
              {t("login.submitAction")}
            </Button>
            <button type="button" className={pageStyles.secondaryButton} style={{ marginTop: "var(--space-3)" }} onClick={() => navigate("/activate")}>
              {t("authHeader.createOrganization")}
            </button>
          </div>
        )}
      </div>

      {uiHidden ? null : <span className={styles.versionFooter}>{t("common:versionLabel", { version: APP_VERSION })}</span>}
    </div>
  );
}
