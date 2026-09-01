import type { ReactNode } from "react";
import styles from "./EmptyState.module.css";

interface EmptyStateProps {
  title?: string;
  message: string;
  action?: ReactNode;
}

// PROSM Time - mirrors PROSM Platform's own EmptyState component
// exactly (§ visual consistency pass): a dashed-border card, the one
// shared "no data yet" treatment every list/table should reuse
// instead of a bare paragraph of secondary text.
export default function EmptyState({ title, message, action }: EmptyStateProps) {
  return (
    <div className={styles.empty} role="status" aria-live="polite">
      {title ? <h3 className={styles.title}>{title}</h3> : null}
      <p className={styles.message}>{message}</p>
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
