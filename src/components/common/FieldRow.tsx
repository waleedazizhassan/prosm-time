import type { CSSProperties, ReactNode } from "react";

import styles from "./FieldRow.module.css";

// Owner 2026-10-26 ("some fields sit higher than the one beside them"):
// fields, date ranges and buttons on one row share one baseline.
export default function FieldRow({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div className={styles.row} style={style}>
      {children}
    </div>
  );
}
