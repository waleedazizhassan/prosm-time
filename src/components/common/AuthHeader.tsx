import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { LANGUAGES } from "../../i18n/languages";
import styles from "./AuthLayout.module.css";

// PROSM Time - the desktop-only header shared by every session-less
// screen (AuthLayout) and the table-free Welcome landing page
// (WelcomePage) - § live UX review, user-directed: one consistent
// Home / Sign in / Create organization / language / contact us bar
// regardless of which of those pages is showing. Extracted out of
// AuthLayout so WelcomePage (which has no form, so doesn't use
// AuthLayout itself) gets the identical header instead of a
// duplicated copy.
export default function AuthHeader() {
  const { t, i18n } = useTranslation("auth");
  const location = useLocation();

  const isActive = (path: string) => location.pathname === path;

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
        <a href="mailto:info@prosm.net" className={styles.headerHelpLink}>
          {t("authHeader.contactUs")}
        </a>
      </div>
    </header>
  );
}
