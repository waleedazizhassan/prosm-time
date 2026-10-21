import type { ReactNode } from "react";

import styles from "./DateRange.module.css";

// Owner 2026-10-21 ("From and To should sit side by side; the gaps are too
// big"): a period's two date fields always share one row, on a phone too.
export default function DateRange({ children }: { children: ReactNode }) {
  return <div className={styles.range}>{children}</div>;
}
