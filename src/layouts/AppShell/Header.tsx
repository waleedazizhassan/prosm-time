import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Menu } from "lucide-react";

import BrandMark from "../../components/common/BrandMark";
import { useAppLayout } from "./LayoutContext";
import NotificationBell from "./NotificationBell";
import styles from "./Header.module.css";

// PROSM Time - the application shell's Header (§ visual consistency
// pass: "consistent PROSM Header"). Fixed 64px bar, same visual
// language as PROSM Platform's own Header - brand identity on the
// left, a mobile sidebar toggle that only renders below 900px (same
// breakpoint Sidebar's own mobile drawer uses). NotificationBell
// (WP-13) is the real feature that now belongs in the right section -
// no other search/AI utilities yet, not invented here just to fill
// the header.
export default function Header() {
  const { t } = useTranslation("shell");
  const { openMobileSidebar } = useAppLayout();

  return (
    <header className={styles.header}>
      <div className={styles.leftSection}>
        <button type="button" className={styles.sidebarToggle} onClick={openMobileSidebar} aria-label={t("toggleSidebar")}>
          <Menu size={20} />
        </button>

        <Link to="/dashboard" className={styles.brand}>
          <BrandMark size={28} />
          <span className={styles.brandName}>PROSM Time</span>
        </Link>
      </div>

      <div className={styles.centerSection} />

      <div className={styles.rightSection}>
        <NotificationBell />
      </div>
    </header>
  );
}
