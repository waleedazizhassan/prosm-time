import type { ReactNode } from "react";
import styles from "./Main.module.css";

export default function Main({ children }: { children: ReactNode }) {
  return <main className={styles.main}>{children}</main>;
}
