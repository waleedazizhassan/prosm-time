import { memo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Capacitor } from "@capacitor/core";
import { ChevronLeft, ChevronRight, LayoutDashboard } from "lucide-react";

import useAppHistory from "../../core/hooks/useAppHistory";
import styles from "./HeaderNavControls.module.css";

// Ported from PROSM Platform's own Header/HeaderNavControls (§ visual
// consistency pass, item 3). Back/Forward mirror real browser history
// via useAppHistory.
//
// § live UX review, user-directed correction - the Dashboard shortcut
// button was removed entirely at the time (the brand mark already
// links there, and on mobile it was the direct cause of the header's
// buttons overlapping the Radio pill once a station name grew the
// pill wider) - only Back/Forward remained.
//
// § user-directed follow-up - a Dashboard button is back, positioned
// BETWEEN Back and Forward, but ONLY for web/desktop
// (!Capacitor.isNativePlatform() - true for plain web and Electron,
// false for the Android build) - the original mobile overlap problem
// this avoided never applied to web/desktop in the first place, and
// Android keeps exactly the 2-button layout that fix already settled
// on. Icons are also slightly bigger across every platform now (the
// user's own explicit ask), not just on this one button.
function HeaderNavControls() {
  const { t } = useTranslation("shell");
  const navigate = useNavigate();
  const { canGoBack, canGoForward, goBack, goForward } = useAppHistory();
  const showDashboardButton = !Capacitor.isNativePlatform();

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
        <ChevronLeft size={22} className={styles.chevron} />
      </button>

      {showDashboardButton ? (
        <button type="button" className={styles.button} onClick={() => navigate("/dashboard")} aria-label={t("nav.dashboard")} title={t("nav.dashboard")}>
          <LayoutDashboard size={20} />
        </button>
      ) : null}

      <button
        type="button"
        className={styles.button}
        onClick={goForward}
        disabled={!canGoForward}
        aria-label={t("nav.forward")}
        title={t("nav.forward")}
      >
        <ChevronRight size={22} className={styles.chevron} />
      </button>
    </div>
  );
}

export default memo(HeaderNavControls);
