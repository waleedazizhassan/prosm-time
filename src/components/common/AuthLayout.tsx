import { useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import AuthHeader from "./AuthHeader";
import authPhoto from "../../assets/splash-photo.webp";
import { APP_VERSION } from "../../core/appVersion";
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
// § user-directed, 2026-09-15 - "clicking the marketing image should
// hide the sign-in form" (all 3 PROSM products, clarified to mean this
// shared shell specifically - Login/Activation/Forgot-Password/Reset-
// Password all route through this one component). uiHidden hides
// .formPanel and strips .shell's own card chrome (background/border/
// shadow/blur) via inline style - inline styles win over the
// >=861px media query's own re-declaration of those same properties,
// which a plain CSS class toggle would lose to on source order alone.
// .brandPanel/.brandPhoto are deliberately NEVER hidden: on mobile
// that's the only remaining visible+clickable surface to toggle back
// with; on desktop it's already display:none via CSS, so nothing
// extra shows there either way.
export default function AuthLayout({ title, subtitle, children, footer }: AuthLayoutProps) {
  const { t } = useTranslation("common");
  const [uiHidden, setUiHidden] = useState(false);

  const toggleUiOnBackgroundClick = (event: MouseEvent) => {
    if (event.target === event.currentTarget) {
      setUiHidden((current) => !current);
    }
  };

  const shellChromeStyle: CSSProperties | undefined = uiHidden
    ? { background: "transparent", borderColor: "transparent", boxShadow: "none", backdropFilter: "none", WebkitBackdropFilter: "none" }
    : undefined;

  return (
    <div className={styles.page} style={{ "--auth-photo": `url(${authPhoto})` } as CSSProperties} onClick={toggleUiOnBackgroundClick}>
      <AuthHeader showVersion={false} />

      {/* § bugfix, 2026-09-15 - the >=861px media query makes .content
          a full flex:1 box covering nearly the entire visible photo
          area, so .page's own onClick almost never actually receives
          the click (.content intercepts it first as the real target).
          Its own onClick+guard here is what makes desktop clicks work
          at all; harmless on mobile where .content is display:contents
          and therefore has no box of its own to be a click target. */}
      <div className={styles.content} onClick={toggleUiOnBackgroundClick}>
        <div className={styles.shell} style={shellChromeStyle}>
          <div className={styles.brandPanel}>
            <div className={styles.brandPhoto} style={{ backgroundImage: `url(${authPhoto})` }} onClick={toggleUiOnBackgroundClick} />
          </div>

          {uiHidden ? null : (
            <div className={styles.formPanel}>
              <h1 className={styles.title}>{title}</h1>
              <p className={styles.subtitle}>{subtitle}</p>
              {children}
              {footer ? <p className={styles.footerLine}>{footer}</p> : null}
            </div>
          )}
        </div>
      </div>

      <span className={styles.versionFooter}>{t("versionLabel", { version: APP_VERSION })}</span>
    </div>
  );
}
