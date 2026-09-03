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
//
// § live UX review, user-directed correction - the previous round
// misread "media center" as this Radio/Weather pair; the user meant
// PROSM Platform's own real HeaderMediaCenter widget (a separate
// component there, not shown here yet - see this file's own follow-up
// work). Layout correction per that same message: Radio/Weather move
// back to the right (grouped with where the media center will sit
// beside them once ported); Dashboard/Back/Forward (HeaderNavControls)
// move into the middle column instead.
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
      </div>

      <div className={styles.centerSection}>
        <HeaderNavControls />
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
