import type { ReactNode } from "react";
import styles from "./Card.module.css";

interface CardProps {
  title?: string;
  children: ReactNode;
}

// PROSM Time - a plain content card matching the same surface-card/
// border-light/radius-lg/shadow-sm treatment PROSM Platform's own
// Table/Modal surfaces already use (§ visual consistency pass), for
// the non-tabular info panels (Dashboard's Organization/License cards).
export default function Card({ title, children }: CardProps) {
  return (
    <div className={styles.card}>
      {title ? <h2 className={styles.cardTitle}>{title}</h2> : null}
      {children}
    </div>
  );
}
