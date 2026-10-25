import type { ReactNode } from "react";

import LegalLinks from "../../modules/legal/LegalLinks";
import styles from "./Main.module.css";

// Owner 2026-10-19: Privacy Policy and Terms of Use at the bottom of every page.
export default function Main({ children }: { children: ReactNode }) {
  return (
    <main className={styles.main}>
      {children}
      <footer className={styles.footer}>
        <LegalLinks />
      </footer>
    </main>
  );
}
