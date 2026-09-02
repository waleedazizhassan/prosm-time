import type { ReactNode } from "react";
import authPhoto from "../../assets/splash-photo.png";
import styles from "./AuthLayout.module.css";

interface AuthLayoutProps {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}

// PROSM Time - shared split-panel shell for every session-less screen
// (Login, Reset Password, Activation, Accept Invitation) - § live UX
// review, user-directed: "all of them should be exactly the same
// card," using the PROSM Platform login reference for the split-panel
// shape (a brand panel + a form panel side by side). Since all five
// pages already route through this one component, redesigning it
// here is what actually makes every one of them identical - no
// per-page changes needed. The brand panel collapses to a slim header
// strip below 860px (AuthLayout.module.css) rather than disappearing,
// so the identity still reads on a phone-sized screen.
//
// § live UX review, user-directed - the brand panel shows the photo
// only, no logo or text over it (previous overlay text/gradient made
// it "look bad"), and the full photo must be visible rather than
// cropped - see .brandPanel's background-size: contain.
export default function AuthLayout({ title, subtitle, children, footer }: AuthLayoutProps) {
  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <div className={styles.brandPanel} style={{ backgroundImage: `url(${authPhoto})` }} />

        <div className={styles.formPanel}>
          <h1 className={styles.title}>{title}</h1>
          <p className={styles.subtitle}>{subtitle}</p>
          {children}
          {footer ? <p className={styles.footerLine}>{footer}</p> : null}
        </div>
      </div>
    </div>
  );
}
