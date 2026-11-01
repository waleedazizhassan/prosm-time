import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Copy, Laptop, Mail, Moon, Sun } from "lucide-react";

import AuthHeader from "../../components/common/AuthHeader";
import Button from "../../components/common/Button";
import logo from "../../assets/brand/prosm-time-logo.png";
import { APP_VERSION } from "../../core/appVersion";
import { LANGUAGES } from "../../i18n/languages";
import { useTheme } from "../../core/context/ThemeContext";
import pageStyles from "../../components/common/AuthLayout.module.css";
import styles from "./WelcomePage.module.css";
import LegalLinks from "../legal/LegalLinks";
import Dropdown from "../../components/common/Dropdown";
import Modal from "../../components/common/Modal";
import { readPublicConfig } from "../../core/services/publicConfig";

// PROSM Time - the first screen: Sign in, Create organization, or try the
// 30-day demo (owner 2026-09-29). Aurora (owner 2026-10-20): the same navy,
// aurora, logo and glass card as the sign-in screens (AuthLayout), on every
// width - a phone gets the language and theme controls in the card, since
// the desktop header is hidden there.
const SALES_EMAIL = "sales@prosm.net";
const WEB_LOGIN_URL = "https://time.prosm.net/login";

// The Google Play build (2026-11-01, Play's payments policy): sign in, the free
// 30-day trial as the only free access, and plans through the sales team by
// email. No prices, no purchase wording, no payment link.
function PlayActions() {
  const { t } = useTranslation("auth");
  const navigate = useNavigate();
  const [salesOpen, setSalesOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showWebLink, setShowWebLink] = useState(true);

  useEffect(() => {
    let active = true;
    void readPublicConfig().then((config) => {
      if (active) setShowWebLink(config.showWebLink);
    });
    return () => {
      active = false;
    };
  }, []);

  const copyEmail = async () => {
    try {
      await navigator.clipboard.writeText(SALES_EMAIL);
      setCopied(true);
    } catch {
      // the address stays on screen to copy by hand
    }
  };

  return (
    <>
      <Button fullWidth onClick={() => navigate("/login")}>
        {t("login.submitAction")}
      </Button>
      <button type="button" className={styles.trialButton} onClick={() => navigate("/activate?demo=1")}>
        <span className={styles.choiceTitle}>
          {t("welcome.trialAction")} <span className={styles.freeBadge}>{t("welcome.freeBadge")}</span>
        </span>
        <span className={styles.choiceHint}>{t("welcome.trialHint")}</span>
      </button>
      <button type="button" className={styles.plansButton} onClick={() => setSalesOpen(true)}>
        <span className={styles.choiceTitle}>{t("welcome.plansAction")}</span>
        <span className={styles.choiceHint}>{t("welcome.plansHint")}</span>
      </button>
      <div className={styles.webNote}>
        <Laptop size={18} aria-hidden="true" />
        <div>
          <p>{t("welcome.webNote")}</p>
          {showWebLink ? (
            <a href={WEB_LOGIN_URL} target="_blank" rel="noopener noreferrer">
              {t("welcome.webAction")}
            </a>
          ) : null}
        </div>
      </div>
      <Modal isOpen={salesOpen} onClose={() => setSalesOpen(false)} title={t("welcome.salesTitle")}>
        <p className={styles.salesText}>{t("welcome.salesBody", { email: SALES_EMAIL })}</p>
        <div className={styles.salesActions}>
          <a className={styles.salesLink} href={`mailto:${SALES_EMAIL}`}>
            <Mail size={16} aria-hidden="true" /> {t("welcome.salesMail")}
          </a>
          <Button variant="ghost" onClick={copyEmail}>
            <Copy size={16} aria-hidden="true" /> {t(copied ? "welcome.salesCopied" : "welcome.salesCopy")}
          </Button>
        </div>
      </Modal>
    </>
  );
}

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
              <Dropdown
                className={styles.mobileLanguageSelect}
                value={i18n.language}
                onChange={(next) => i18n.changeLanguage(next)}
                ariaLabel={t("authHeader.languageAriaLabel")}
                options={LANGUAGES.map((language) => ({ value: language.code, label: language.nativeLabel }))}
              />
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

            {import.meta.env.VITE_DISTRIBUTION === "play" ? (
              <PlayActions />
            ) : (
              <>
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
              </>
            )}
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
