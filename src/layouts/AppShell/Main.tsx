import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import LegalLinks from "../../modules/legal/LegalLinks";
import useTrialStatus from "../../modules/activation/useTrialStatus";
import { APP_VERSION } from "../../core/appVersion";
import styles from "./Main.module.css";

// Owner 2026-10-19: Privacy Policy and Terms of Use at the bottom of every page.
// Owner 2026-10-26: the version stays here at the foot of the page (only the
// sidebar dropped it, step 16).
// Owner 2026-10-26: during the trial the footer keeps the days left (the
// banner above can be closed); a licensed copy shows nothing here.
export default function Main({ children }: { children: ReactNode }) {
  const { t } = useTranslation("common");
  const { t: tShell } = useTranslation("shell");
  const { status } = useTrialStatus(true);
  const trial = status?.isTrial && !status.locked && status.isOwner;
  return (
    <main className={styles.main}>
      {children}
      <footer className={styles.footer}>
        <LegalLinks />
        <span aria-hidden="true">·</span>
        <span>{t("versionLabel", { version: APP_VERSION })}</span>
        {trial ? (
          <>
            <span aria-hidden="true">·</span>
            <a className={styles.trial} href="mailto:sales@prosm.net">
              {tShell("trial.footer", { count: status?.daysLeft ?? 0 })}
            </a>
          </>
        ) : null}
      </footer>
    </main>
  );
}
