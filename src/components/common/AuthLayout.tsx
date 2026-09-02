import type { CSSProperties, ReactNode } from "react";
import AuthHeader from "./AuthHeader";
import authPhoto from "../../assets/splash-photo.png";
import styles from "./AuthLayout.module.css";

interface AuthLayoutProps {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}

// PROSM Time - shared shell for every session-less screen (Login,
// Reset Password, Activation, Accept Invitation) - § live UX review,
// user-directed: "all of them should be exactly the same card." Since
// all five pages already route through this one component,
// redesigning it here is what actually makes every one of them
// identical - no per-page changes needed.
//
// § live UX review, user-directed - two different treatments by
// breakpoint (AuthLayout.module.css):
// - Desktop (>=861px): the photo is the full page background behind a
//   fixed header (Sign in / Create organization / language / contact
//   us) and a single floating glass-card form - no split panel.
// - Mobile (<=860px): unchanged from the previous round - the split
//   card with its own capped-height photo band on top, no header (the
//   .brandPanel/.brandPhoto pair below only ever renders there; the
//   desktop CSS hides it in favor of the full-page background).
export default function AuthLayout({ title, subtitle, children, footer }: AuthLayoutProps) {
  return (
    <div className={styles.page} style={{ "--auth-photo": `url(${authPhoto})` } as CSSProperties}>
      <AuthHeader />

      <div className={styles.content}>
        <div className={styles.shell}>
          <div className={styles.brandPanel}>
            <div className={styles.brandPhoto} style={{ backgroundImage: `url(${authPhoto})` }} />
          </div>

          <div className={styles.formPanel}>
            <h1 className={styles.title}>{title}</h1>
            <p className={styles.subtitle}>{subtitle}</p>
            {children}
            {footer ? <p className={styles.footerLine}>{footer}</p> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
