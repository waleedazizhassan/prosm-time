import type { ReactNode } from "react";

import styles from "./ActionBar.module.css";

// Plan stage 4.5: one row of actions for every approval card, so a button never
// leaves its card or gets cut at the edge. Put the deciding actions first.
export default function ActionBar({ children }: { children: ReactNode }) {
  return <div className={styles.bar}>{children}</div>;
}
