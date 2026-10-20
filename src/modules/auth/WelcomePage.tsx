import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Sun, Moon } from "lucide-react";

import AuthHeader from "../../components/common/AuthHeader";
import Button from "../../components/common/Button";
import logo from "../../assets/brand/prosm-time-logo.png";
import { APP_VERSION } from "../../core/appVersion";
import { LANGUAGES } from "../../i18n/languages";
import { useTheme } from "../../core/context/ThemeContext";
import pageStyles from "../../components/common/AuthLayout.module.css";
import styles from "./WelcomePage.module.css";
import LegalLinks from "../legal/LegalLinks";

// PROSM Time - the first screen: Sign in, Create organization, or try the
// 30-day demo (owner 2026-09-29). Aurora (owner 2026-10-20): the same navy,
// aurora, logo and glass card as the sign-in screens (AuthLayout), on every
// width - a phone gets the language and theme controls in the card, since
// the desktop header is hidden there.
export default function WelcomePage() {
  const { t, i18n } = useTranslation("auth");
  const navigate = useNavigate();
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <div className={pageStyles.page}>
      <AuthHeader showVersion={false} />

      <div className={pageStyles.content}>
        <div className={pageStyles.shell}>
          <div className={pageStyles.brandPanel}>
            <img src={logo} alt="PROSM Time" className={pageStyles.brandLogo} />
            <p className={pageStyles.brandTagline}>{t("common:auth.tagline")}</p>
            <ul className={pageStyles.brandPoints}>
              <li className={pageStyles.brandPoint}>{t("common:auth.point1")}</li>
              <li className={pageStyles.brandPoint}>{t("common:auth.point2")}</li>
              <li className={pageStyles.brandPoint}>{t("common:auth.point3")}</li>
            </ul>
          </div>

          <div className={pageStyles.formPanel}>
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

            <h1 className={pageStyles.title}>{t("welcome.title")}</h1>
            <p className={pageStyles.subtitle}>{t("welcome.subtitle")}</p>

            <Button fullWidth onClick={() => navigate("/login")}>
              {t("login.submitAction")}
            </Button>
            <button type="button" className={pageStyles.secondaryButton} style={{ marginTop: "var(--space-3)" }} onClick={() => navigate("/activate")}>
              {t("authHeader.createOrganization")}
            </button>
            {/* Demo (owner 2026-09-29): the same activation, without the activation code, for 30 days. */}
            <button type="button" className={pageStyles.secondaryButton} style={{ marginTop: "var(--space-3)" }} onClick={() => navigate("/activate?demo=1")}>
              {t("authHeader.useDemo")}
            </button>
          </div>
        </div>
      </div>

      <span className={pageStyles.versionFooter}>
        <span>{t("common:versionLabel", { version: APP_VERSION })}</span>
        <LegalLinks />
      </span>
    </div>
  );
}
