import type { ReactNode } from "react";
import styles from "./PageShell.module.css";

interface PageShellProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}

// PROSM Time - mirrors PROSM Platform's own EnterprisePage shell
// exactly (§ visual consistency pass): title + subtitle + actions +
// content well, so every screen shares one header/spacing pattern
// instead of reinventing it.
export default function PageShell({ title, subtitle, actions, wide = false, children }: PageShellProps) {
  return (
    <div className={[styles.container, wide ? styles.wide : ""].filter(Boolean).join(" ")}>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.title}>{title}</h1>
          {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
        </div>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
      <div className={styles.content}>{children}</div>
    </div>
  );
}
