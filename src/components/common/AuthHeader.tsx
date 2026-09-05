import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { LANGUAGES } from "../../i18n/languages";
import { APP_VERSION } from "../../core/appVersion";
import styles from "./AuthLayout.module.css";

// PROSM Platform's own product/plan/entitlement registry
// (prosm_products/prosm_product_plans/prosm_entitlements, product_key
// "prosm-time") - the real, currently-active plans, in their real
// sort order. `null` max sites = the "max_sites" entitlement's own
// limit_value is effectively unlimited (999999) on that plan.
const PLAN_KEYS = ["free", "professional", "enterprise"] as const;
const PLAN_MAX_SITES: Record<(typeof PLAN_KEYS)[number], number | null> = {
  free: 1,
  professional: 10,
  enterprise: null,
};

// PROSM Time - the desktop-only header shared by every session-less
// screen (AuthLayout) and the table-free Welcome landing page
// (WelcomePage) - § live UX review, user-directed: one consistent
// Home / Sign in / Create organization / language / contact us bar
// regardless of which of those pages is showing. Extracted out of
// AuthLayout so WelcomePage (which has no form, so doesn't use
// AuthLayout itself) gets the identical header instead of a
// duplicated copy.
//
// § live UX review, user-directed - "Home" now leaves the app
// entirely (a plain external link back to prosm.net, not the internal
// /welcome route) and "Contact us" became "Get an activation code": a
// click reveals PROSM Time's real, currently-configured plans (name,
// description, site limit - sourced from PROSM Platform's own product/
// plan/entitlement registry, prosm_products/prosm_product_plans/
// prosm_entitlements, product_key "prosm-time") ending in the sales
// email, instead of the old support/info email panel - a visitor here
// hasn't signed up yet, so "how do I get started" matters more than
// general support. This panel's plan data is a point-in-time snapshot
// (no live cross-project API call - PROSM Time and PROSM Platform are
// separate Supabase projects) - keep it in sync by hand if the real
// plans/entitlements ever change.
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
        <a href="https://prosm.net" className={styles.headerNavLink}>
          {t("authHeader.backToProsm")}
        </a>
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
            {t("authHeader.getActivationCode")}
          </button>

          {contactOpen ? (
            <div className={`${styles.contactPanel} ${styles.plansPanel}`} role="menu">
              <span className={styles.contactPanelLabel}>{t("authHeader.plansIntro")}</span>

              {PLAN_KEYS.map((planKey) => (
                <div key={planKey} className={styles.planCard}>
                  <span className={styles.planName}>{t(`authHeader.plans.${planKey}.name`)}</span>
                  <span className={styles.planDescription}>{t(`authHeader.plans.${planKey}.description`)}</span>
                  <span className={styles.planMeta}>
                    {PLAN_MAX_SITES[planKey] === null ? t("authHeader.plansMaxSitesUnlimited") : t("authHeader.plansMaxSitesLabel", { count: PLAN_MAX_SITES[planKey] })}
                  </span>
                </div>
              ))}

              <span className={styles.contactPanelLabel}>{t("authHeader.salesEmailLabel")}</span>
              <a href="mailto:sales@prosm.net" className={styles.contactPanelEmail}>
                sales@prosm.net
              </a>
            </div>
          ) : null}
        </div>

        {showVersion ? <span className={styles.headerVersion}>{t("common:versionLabel", { version: APP_VERSION })}</span> : null}
      </div>
    </header>
  );
}
