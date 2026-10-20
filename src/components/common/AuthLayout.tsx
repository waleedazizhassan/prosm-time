import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import AuthHeader from "./AuthHeader";
import logo from "../../assets/brand/prosm-time-logo.png";
import { APP_VERSION } from "../../core/appVersion";
import LegalLinks from "../../modules/legal/LegalLinks";
import styles from "./AuthLayout.module.css";

interface AuthLayoutProps {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}

// PROSM Time - shared shell for every session-less screen (Login,
// Reset Password, Activation, Accept Invitation): "all of them should be
// exactly the same card."
//
// Aurora (owner 2026-10-20: a world-class, original look, from the new
// logo). The page is the logo's deep navy with a soft aurora; the full
// logo, a one-line promise and three points stand beside one glass card
// holding the form (above it on a phone). The old marketing photo - and
// the "click the photo to hide the form" behaviour that came with it - is
// gone.
export default function AuthLayout({ title, subtitle, children, footer }: AuthLayoutProps) {
  const { t } = useTranslation("common");

  return (
    <div className={styles.page}>
      <AuthHeader showVersion={false} />

      <div className={styles.content}>
        <div className={styles.shell}>
          <div className={styles.brandPanel}>
            <img src={logo} alt="PROSM Time" className={styles.brandLogo} />
            <p className={styles.brandTagline}>{t("auth.tagline")}</p>
            <ul className={styles.brandPoints}>
              <li className={styles.brandPoint}>{t("auth.point1")}</li>
              <li className={styles.brandPoint}>{t("auth.point2")}</li>
              <li className={styles.brandPoint}>{t("auth.point3")}</li>
            </ul>
          </div>

          <div className={styles.formPanel}>
            <h1 className={styles.title}>{title}</h1>
            <p className={styles.subtitle}>{subtitle}</p>
            {children}
            {footer ? <p className={styles.footerLine}>{footer}</p> : null}
          </div>
        </div>
      </div>

      <span className={styles.versionFooter}>
        <span>{t("versionLabel", { version: APP_VERSION })}</span>
        <LegalLinks />
      </span>
    </div>
  );
}
