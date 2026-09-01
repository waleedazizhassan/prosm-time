import type { ReactNode } from "react";
import styles from "./ListRow.module.css";

interface ListRowProps {
  children: ReactNode;
}

// PROSM Time - the one "text block + trailing action(s)" list-row
// treatment, consolidated out of five near-identical ad-hoc inline/
// const definitions across PersonDetailPage/SiteDetailPage/
// ManagerConsolePage/TimesheetsPage. Adds flex-wrap: wrap (missing
// from every prior copy), a genuine mobile-responsiveness fix - long
// row content no longer forces trailing action buttons to overflow or
// get squeezed on narrow screens; they wrap to their own line instead.
export default function ListRow({ children }: ListRowProps) {
  return <div className={styles.row}>{children}</div>;
}
