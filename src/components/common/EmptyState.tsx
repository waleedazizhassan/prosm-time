import type { ReactNode } from "react";
import type { StateKind } from "../../core/utils/errorKind";
import type { LucideIcon } from "lucide-react";
import { STATE_ICON } from "./stateIcons";
import styles from "./EmptyState.module.css";

interface EmptyStateProps {
  title?: string;
  message: string;
  action?: ReactNode;
  // § user-directed, 2026-09-11 - a transparent PNG (background
  // removed so it sits on the card's own themed surface, not a
  // mismatched box) for a small illustration on a genuinely positive
  // empty state ("all caught up", not a bare "no data" table). Opt-in
  // per call site, not a default - most EmptyState uses across this
  // app are plain lists/tables where an illustration would just be
  // visual noise, not every one of them.
  illustrationSrc?: string;
  // v2.3.43 step 21 (owner 2026-10-26, replacing the opt-in rule above for
  // the default): every empty state carries a small fitting picture -
  // "empty" unless the page names another kind (e.g. "notFound" for a
  // search with no results, "success" for "all caught up").
  kind?: StateKind;
  /** a sign that fits the page (e.g. a calendar for leave); else the kind's own */
  icon?: LucideIcon;
}

// PROSM Time - mirrors PROSM Platform's own EmptyState component
// exactly (§ visual consistency pass): a dashed-border card, the one
// shared "no data yet" treatment every list/table should reuse
// instead of a bare paragraph of secondary text.
export default function EmptyState({ title, message, action, illustrationSrc, kind, icon }: EmptyStateProps) {
  const Icon = icon ?? STATE_ICON[kind ?? "empty"];
  return (
    <div className={styles.empty} role="status" aria-live="polite">
      {illustrationSrc ? <img src={illustrationSrc} alt="" className={styles.illustration} /> : (
        <span className={`${styles.stateIcon} ${kind === "success" ? styles.stateIconGood : ""}`} aria-hidden="true"><Icon size={26} strokeWidth={1.75} /></span>
      )}
      {title ? <h3 className={styles.title}>{title}</h3> : null}
      <p className={styles.message}>{message}</p>
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
