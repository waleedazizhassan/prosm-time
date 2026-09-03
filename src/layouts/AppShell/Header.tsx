import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Menu } from "lucide-react";

import BrandMark from "../../components/common/BrandMark";
import { useAppLayout } from "./LayoutContext";
import NotificationBell from "./NotificationBell";
import HeaderNavControls from "./HeaderNavControls";
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
// Left: brand identity + Back/Forward/Dashboard (HeaderNavControls) -
// Dashboard's ONLY navigation entry point now (the Sidebar's own
// duplicate was removed, see navigation.ts). Right: a compact
// Organization/License quick-look (HeaderOrganizationCard, replacing
// the Dashboard's old large cards), Radio, Weather, a personalized
// greeting, and notifications. The User Menu itself stays anchored at
// the Sidebar's own footer (UserMenu.tsx) - that already matches
// PROSM Platform's own current architecture (moved out of the Header
// there too), not the Header.
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

      {/* § live UX review, user-directed - "the media center [Radio +
          Weather], like PROSM Platform, centered in the header,
          visible on both mobile and desktop." Moved out of the right
          section (where they competed for space with the
          Organization card/greeting/notifications, both of which
          already hide at narrower widths) into this grid's own middle
          `1fr` column - reserved for exactly this since the header was
          first built, previously left empty. */}
      <div className={styles.centerSection}>
        <HeaderRadio />
        <WeatherMiniPanel />
      </div>

      <div className={styles.rightSection}>
        <HeaderOrganizationCard />
        <HeaderGreeting />
        <NotificationBell />
      </div>
    </header>
  );
}
