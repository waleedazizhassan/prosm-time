import { Component, type ErrorInfo, type ReactNode } from "react";
import i18next from "../../i18n";
import styles from "./ErrorBoundary.module.css";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

// PROSM Time WP-23 - "Production Readiness: error handling." Without
// this, a render-time error anywhere in the tree white-screens the
// entire application with no recovery path. Presentation-only (mirrors
// §31's Splash Screen rule for the same reason: no business logic,
// no data access) - it only ever renders a fallback and logs to the
// console with enough context to diagnose, never attempts to recover
// application state itself.
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[PROSM Time] Unhandled render error:", error, errorInfo.componentStack);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <div className={styles.page}>
          <div className={styles.card}>
            <h1 className={styles.title}>{i18next.t("common:errorBoundary.title")}</h1>
            <p className={styles.message}>{i18next.t("common:errorBoundary.message")}</p>
            <button type="button" className={styles.reloadButton} onClick={this.handleReload}>
              {i18next.t("common:errorBoundary.reloadAction")}
            </button>
            <p className={styles.contact}>
              {i18next.t("common:errorBoundary.contactPrefix")}{" "}
              <a href="mailto:info@prosm.net" className={styles.contactLink}>
                info@prosm.net
              </a>
              .
            </p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
