import { memo } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, LayoutDashboard } from "lucide-react";

import useAppHistory from "../../core/hooks/useAppHistory";
import styles from "./HeaderNavControls.module.css";

// Ported from PROSM Platform's own Header/HeaderNavControls (§ visual
// consistency pass, item 3). Back/Forward mirror real browser history
// via useAppHistory, Dashboard is a fixed shortcut home - independent
// of history position, always enabled, always goes to /dashboard.
function HeaderNavControls() {
  const { t } = useTranslation("shell");
  const navigate = useNavigate();
  const location = useLocation();
  const { canGoBack, canGoForward, goBack, goForward } = useAppHistory();

  const onDashboard = location.pathname === "/dashboard";

  return (
    <div className={styles.container}>
      <button
        type="button"
        className={styles.button}
        onClick={goBack}
        disabled={!canGoBack}
        aria-label={t("nav.back")}
        title={t("nav.back")}
      >
        <ChevronLeft size={18} className={styles.chevron} />
      </button>

      <button
        type="button"
        className={styles.button}
        onClick={goForward}
        disabled={!canGoForward}
        aria-label={t("nav.forward")}
        title={t("nav.forward")}
      >
        <ChevronRight size={18} className={styles.chevron} />
      </button>

      <button
        type="button"
        className={`${styles.button} ${onDashboard ? styles.active : ""}`}
        onClick={() => navigate("/dashboard")}
        aria-label={t("nav.dashboard")}
        aria-current={onDashboard ? "page" : undefined}
        title={t("nav.dashboard")}
      >
        <LayoutDashboard size={18} />
      </button>
    </div>
  );
}

export default memo(HeaderNavControls);
