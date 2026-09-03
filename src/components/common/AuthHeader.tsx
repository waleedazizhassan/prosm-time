import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { LANGUAGES } from "../../i18n/languages";
import { APP_VERSION } from "../../core/appVersion";
import styles from "./AuthLayout.module.css";

// PROSM Time - the desktop-only header shared by every session-less
// screen (AuthLayout) and the table-free Welcome landing page
// (WelcomePage) - § live UX review, user-directed: one consistent
// Home / Sign in / Create organization / language / contact us bar
// regardless of which of those pages is showing. Extracted out of
// AuthLayout so WelcomePage (which has no form, so doesn't use
// AuthLayout itself) gets the identical header instead of a
// duplicated copy.
//
// § live UX review, user-directed - "Contact us" should show the
// support/info emails, not jump straight to composing a mail: a click
// reveals both addresses (still real mailto links, so a second click
// on either one does open a mail client) instead of firing mailto:
// on the header button itself.
//
// § live UX review, user-directed - "the version number on the
// Welcome page belongs at the bottom, not the header" - WelcomePage
// renders its own bottom-positioned version text instead and passes
// showVersion={false} here; every other page keeps it in the header.
export default function AuthHeader({ showVersion = true }: { showVersion?: boolean }) {
  const { t, i18n } = useTranslation("auth");
  const location = useLocation();
  const [contactOpen, setContactOpen] = useState(false);
  const contactRef = useRef<HTMLDivElement>(null);

  const isActive = (path: string) => location.pathname === path;

  useEffect(() => {
    if (!contactOpen) return undefined;

    function handleClickOutside(event: MouseEvent) {
      if (!contactRef.current?.contains(event.target as Node)) setContactOpen(false);
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setContactOpen(false);
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [contactOpen]);

  return (
    <header className={styles.authHeader}>
      <nav className={styles.headerNav}>
        <Link to="/welcome" className={`${styles.headerNavLink} ${isActive("/welcome") ? styles.headerNavLinkActive : ""}`}>
          {t("authHeader.home")}
        </Link>
        <Link to="/login" className={`${styles.headerNavLink} ${isActive("/login") ? styles.headerNavLinkActive : ""}`}>
          {t("login.submitAction")}
        </Link>
        <Link to="/activate" className={`${styles.headerNavLink} ${isActive("/activate") ? styles.headerNavLinkActive : ""}`}>
          {t("authHeader.createOrganization")}
        </Link>
      </nav>

      <div className={styles.headerActions}>
        <select
          className={styles.headerLanguageSelect}
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

        <div ref={contactRef} className={styles.contactWrapper}>
          <button type="button" className={styles.headerHelpLink} onClick={() => setContactOpen((open) => !open)} aria-haspopup="true" aria-expanded={contactOpen}>
            {t("authHeader.contactUs")}
          </button>

          {contactOpen ? (
            <div className={styles.contactPanel} role="menu">
              <span className={styles.contactPanelLabel}>{t("authHeader.supportEmailLabel")}</span>
              <a href="mailto:support@prosm.net" className={styles.contactPanelEmail}>
                support@prosm.net
              </a>
              <span className={styles.contactPanelLabel}>{t("authHeader.infoEmailLabel")}</span>
              <a href="mailto:info@prosm.net" className={styles.contactPanelEmail}>
                info@prosm.net
              </a>
            </div>
          ) : null}
        </div>

        {showVersion ? <span className={styles.headerVersion}>{t("common:versionLabel", { version: APP_VERSION })}</span> : null}
      </div>
    </header>
  );
}
