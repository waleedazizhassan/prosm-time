import type { ReactNode } from "react";
import styles from "./Card.module.css";

interface CardProps {
  title?: string;
  // A line under the title saying what the card is for (owner 2026-10-20:
  // replaces the many hand-styled hint paragraphs).
  subtitle?: ReactNode;
  // Buttons on the title row (they drop below the title on a phone).
  actions?: ReactNode;
  // Edge-to-edge content (a table or list) - no inner padding, no double border.
  flush?: boolean;
  className?: string;
  children: ReactNode;
}

export default function Card({ title, subtitle, actions, flush = false, className, children }: CardProps) {
  const hasHeader = Boolean(title || subtitle || actions);
  return (
    <div className={[styles.card, flush ? styles.flush : "", className].filter(Boolean).join(" ")}>
      {hasHeader ? (
        <div className={styles.header}>
          <div className={styles.headerText}>
            {title ? <h2 className={styles.cardTitle}>{title}</h2> : null}
            {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
          </div>
          {actions ? <div className={styles.actions}>{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}
