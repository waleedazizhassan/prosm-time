import type { ReactNode } from "react";
import styles from "./StatusBadge.module.css";

// PROSM Time - mirrors PROSM Platform's own StatusBadge component
// exactly (§ visual consistency pass): a status-name -> tone lookup, so
// a new status word is one entry here, never a new CSS block. Covers
// this product's own status vocabulary (organizations, users, license
// records, activation codes, device bindings).
const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = {
  active: "success",
  approved: "success",
  ACTIVE: "success",

  invited: "info",
  pending: "warning",
  CONSUMED: "info",

  suspended: "warning",
  SUSPENDED: "warning",
  blocked: "danger",

  deactivated: "danger",
  revoked: "danger",
  REVOKED: "danger",
  expired: "danger",
  EXPIRED: "danger",

  clockedIn: "success",
  onBreak: "warning",
  notClockedIn: "neutral",
};

export default function StatusBadge({ status, children }: { status: string; children: ReactNode }) {
  const tone = STATUS_TONE[status] ?? "neutral";

  return (
    <span className={`${styles.badge} ${styles[tone]}`}>
      <span className={styles.dot} aria-hidden="true" />
      {children}
    </span>
  );
}
