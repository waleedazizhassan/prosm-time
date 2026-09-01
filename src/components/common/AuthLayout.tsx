import type { ReactNode } from "react";
import BrandMark from "./BrandMark";
import styles from "./AuthLayout.module.css";

interface AuthLayoutProps {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}

// PROSM Time - shared centered card shell for the three session-less
// screens (Activation, Login, Accept Invitation), matching the same
// surface-card/border-light/radius-lg/shadow-sm treatment every other
// PROSM surface uses (§ visual consistency pass) instead of each
// screen rolling its own layout.
export default function AuthLayout({ title, subtitle, children, footer }: AuthLayoutProps) {
  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.brandRow}>
          <BrandMark size={72} />
        </div>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.subtitle}>{subtitle}</p>
        {children}
        {footer ? <p className={styles.footerLine}>{footer}</p> : null}
      </div>
    </div>
  );
}
