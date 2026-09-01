import styles from "./LoadingState.module.css";

interface LoadingStateProps {
  message?: string;
  size?: "sm" | "md" | "lg";
  fullHeight?: boolean;
}

// PROSM Time - mirrors PROSM Platform's own LoadingState component
// exactly (§ visual consistency pass): a spinner + optional message,
// the one shared loading indicator every page/card should reuse
// instead of a bare "…" placeholder.
export default function LoadingState({ message, size = "md", fullHeight = false }: LoadingStateProps) {
  return (
    <div className={[styles.container, fullHeight ? styles.fullHeight : ""].filter(Boolean).join(" ")} role="status" aria-live="polite">
      <span className={[styles.spinner, styles[size]].filter(Boolean).join(" ")} aria-hidden="true" />
      {message ? <p className={styles.message}>{message}</p> : null}
    </div>
  );
}
