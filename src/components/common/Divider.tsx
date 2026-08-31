import styles from "./Divider.module.css";

interface DividerProps {
  orientation?: "horizontal" | "vertical";
  label?: string;
  className?: string;
}

// PROSM Time - mirrors PROSM Platform's own Divider component exactly
// (§ visual consistency pass, user-directed): horizontal by default,
// vertical for inline use, an optional label renders centered text
// with a line on each side (e.g. "OR" between two auth entry points).
export default function Divider({ orientation = "horizontal", label, className = "" }: DividerProps) {
  if (orientation === "vertical") {
    return <span className={[styles.vertical, className].filter(Boolean).join(" ")} role="separator" aria-orientation="vertical" />;
  }

  if (label) {
    return (
      <div className={[styles.labelledRow, className].filter(Boolean).join(" ")} role="separator" aria-orientation="horizontal">
        <span className={styles.line} />
        <span className={styles.label}>{label}</span>
        <span className={styles.line} />
      </div>
    );
  }

  return <hr className={[styles.horizontal, className].filter(Boolean).join(" ")} />;
}
