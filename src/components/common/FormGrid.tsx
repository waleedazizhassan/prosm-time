import type { ReactNode } from "react";
import styles from "./FormGrid.module.css";

interface FormGridProps {
  columns?: 1 | 2 | 3 | 4;
  gap?: "sm" | "md" | "lg";
  alignItems?: "start" | "end" | "center";
  children: ReactNode;
}

// PROSM Time - mirrors PROSM Platform's own FormGrid component exactly
// (§ visual consistency pass): auto-fit columns that collapse to a
// single column under 768px, the real responsive pattern behind every
// multi-field form row - never a bare inline `gridTemplateColumns`
// with no mobile fallback.
export default function FormGrid({ columns = 2, gap = "md", alignItems, children }: FormGridProps) {
  const gapClass = gap === "sm" ? styles.gapSm : gap === "lg" ? styles.gapLg : styles.gapMd;
  const columnsClass = styles[`columns${columns}` as const];
  return (
    <div className={[styles.grid, columnsClass, gapClass].filter(Boolean).join(" ")} style={alignItems ? { alignItems } : undefined}>
      {children}
    </div>
  );
}
