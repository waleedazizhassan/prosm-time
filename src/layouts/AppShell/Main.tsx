import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import LegalLinks from "../../modules/legal/LegalLinks";
import { APP_VERSION } from "../../core/appVersion";
import styles from "./Main.module.css";

// Owner 2026-10-19: Privacy Policy and Terms of Use at the bottom of every page.
export default function Main({ children }: { children: ReactNode }) {
  const { t } = useTranslation("common");
  return (
    <main className={styles.main}>
      {children}
      <footer className={styles.footer}>
        <LegalLinks />
        <span aria-hidden="true">·</span>
        <span>{t("versionLabel", { version: APP_VERSION })}</span>
      </footer>
    </main>
  );
}
