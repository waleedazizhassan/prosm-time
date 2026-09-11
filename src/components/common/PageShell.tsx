import type { ReactNode } from "react";
import styles from "./PageShell.module.css";

interface PageShellProps {
  // § user-directed, 2026-09-11 - Dashboard's Owner/Manager view has
  // its own complete greeting banner inside AdminOverviewCard now;
  // PageShell's own title/subtitle above it was pure duplication and
  // left an empty gap before the real content. Falsy/omitted title
  // skips the whole header block (not just the text) so that gap goes
  // away entirely - every other screen still passes a real title.
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  wide?: boolean;
  // § live UX review, user-directed - "shrink or remove the 'Dashboard'
  // title" so the map+clock-in card is the first thing seen. Opt-in
  // only (Dashboard alone) - every other screen keeps its normal title.
  compact?: boolean;
  children: ReactNode;
}

// PROSM Time - mirrors PROSM Platform's own EnterprisePage shell
// exactly (§ visual consistency pass): title + subtitle + actions +
// content well, so every screen shares one header/spacing pattern
// instead of reinventing it.
export default function PageShell({ title, subtitle, actions, wide = false, compact = false, children }: PageShellProps) {
  return (
    <div className={[styles.container, wide ? styles.wide : ""].filter(Boolean).join(" ")}>
      {title ? (
        <div className={[styles.pageHeader, compact ? styles.pageHeaderCompact : ""].filter(Boolean).join(" ")}>
          <div>
            <h1 className={[styles.title, compact ? styles.titleCompact : ""].filter(Boolean).join(" ")}>{title}</h1>
            {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
          </div>
          {actions ? <div className={styles.actions}>{actions}</div> : null}
        </div>
      ) : null}
      <div className={styles.content}>{children}</div>
    </div>
  );
}
