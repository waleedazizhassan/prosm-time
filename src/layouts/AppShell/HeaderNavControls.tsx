import { memo } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "lucide-react";

import useAppHistory from "../../core/hooks/useAppHistory";
import styles from "./HeaderNavControls.module.css";

// Ported from PROSM Platform's own Header/HeaderNavControls (§ visual
// consistency pass, item 3). Back/Forward mirror real browser history
// via useAppHistory.
//
// § live UX review, user-directed correction - the Dashboard shortcut
// button is removed entirely (the brand mark already links there, and
// on mobile it was the direct cause of the header's buttons
// overlapping the Radio pill once a station name grew the pill wider)
// - only Back/Forward remain.
function HeaderNavControls() {
  const { t } = useTranslation("shell");
  const { canGoBack, canGoForward, goBack, goForward } = useAppHistory();

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
    </div>
  );
}

export default memo(HeaderNavControls);
