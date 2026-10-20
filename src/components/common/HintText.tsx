import type { ReactNode } from "react";

import styles from "./HintText.module.css";

// Owner 2026-10-20 ("polish it"): one look for the short explanatory lines
// under titles and fields - about 80 of them were hand-styled, each a
// little different. `small` for a field's helper line.
export default function HintText({ children, small = false }: { children: ReactNode; small?: boolean }) {
  if (!children) return null;
  return <p className={[styles.hint, small ? styles.small : ""].filter(Boolean).join(" ")}>{children}</p>;
}
