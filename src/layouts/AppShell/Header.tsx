import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Menu } from "lucide-react";

import BrandMark from "../../components/common/BrandMark";
import { useAppLayout } from "./LayoutContext";
import NotificationBell from "./NotificationBell";
import HeaderNavControls from "./HeaderNavControls";
import HeaderGreeting from "./HeaderGreeting";
import WeatherMiniPanel from "./WeatherMiniPanel";
import styles from "./Header.module.css";

// PROSM Time - the application shell's Header (§ visual consistency
// pass: "consistent PROSM Header"). Fixed 64px bar, same visual
// language as PROSM Platform's own Header - brand identity + Back/
// Forward/Dashboard nav controls on the left (matching Platform's own
// HeaderNavControls), a mobile sidebar toggle that only renders below
// 900px (same breakpoint Sidebar's own mobile drawer uses), and a
// personalized time-of-day greeting on the right (matching Platform's
// own HeaderGreeting). The User Menu itself stays anchored at the
// Sidebar's own footer (UserMenu.tsx) - that already matches PROSM
// Platform's own current architecture (moved out of the Header there
// too), not the Header. NotificationBell (WP-13) is the one other real
// feature that belongs in the right section - no search/AI utilities
// yet, not invented here just to fill the header.
export default function Header() {
  const { t } = useTranslation(["shell", "common"]);
  const { openMobileSidebar } = useAppLayout();

  return (
    <header className={styles.header}>
      <div className={styles.leftSection}>
        <button type="button" className={styles.sidebarToggle} onClick={openMobileSidebar} aria-label={t("shell:toggleSidebar")}>
          <Menu size={20} />
        </button>

        <Link to="/dashboard" className={styles.brand}>
          <BrandMark size={28} />
          <span className={styles.brandName}>{t("common:appName")}</span>
        </Link>

        <HeaderNavControls />
      </div>

      <div className={styles.centerSection} />

      <div className={styles.rightSection}>
        <WeatherMiniPanel />
        <HeaderGreeting />
        <NotificationBell />
      </div>
    </header>
  );
}
