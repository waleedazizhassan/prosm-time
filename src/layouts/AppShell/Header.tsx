import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Menu } from "lucide-react";

import BrandMark from "../../components/common/BrandMark";
import { useAppLayout } from "./LayoutContext";
import NotificationBell from "./NotificationBell";
import HeaderNavControls from "./HeaderNavControls";
import CommandPalette from "./CommandPalette";
import HeaderGreeting from "./HeaderGreeting";
import WeatherMiniPanel from "./WeatherMiniPanel";
import HeaderRadio from "./HeaderRadio";
import HeaderOrganizationCard from "./HeaderOrganizationCard";
import styles from "./Header.module.css";

// PROSM Time - the application shell's Header (§ final visual
// consistency pass, correction: "Bring the PROSM Time Header closer to
// the established PROSM Platform experience... Radio, Weather, Back,
// Forward, Dashboard, greeting, existing notification/user controls").
// Fixed 64px bar, same visual language as PROSM Platform's own Header.
//
// § user-directed, 2026-09-15 ("عايز توحيد للهيدر لكل المنتجات...
// زراير الاسم والداشبورد والبحث الحجم الاشعارات" - unify the header
// FORMAT across products regardless of each product's own centers/
// capabilities, specifically: brand, dashboard nav, search, sizing,
// notifications). Matches Platform's own Header/index.jsx section
// layout exactly: brand + nav controls together in the LEFT section,
// a real search (CommandPalette) in the CENTER - previously
// HeaderNavControls sat alone in the center and there was no search
// at all. Radio/Weather/notifications/greeting/org card stay in the
// right section, same as before (Time's own real "centers", not
// touched - only the layout format changed).
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

      <div className={styles.centerSection}>
        <CommandPalette />
      </div>

      <div className={styles.rightSection}>
        <HeaderOrganizationCard />
        <HeaderRadio />
        <WeatherMiniPanel />
        <HeaderGreeting />
        <NotificationBell />
      </div>
    </header>
  );
}
