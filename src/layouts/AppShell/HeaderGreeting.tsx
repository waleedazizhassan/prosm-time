import { memo } from "react";
import { Sunrise, Sun, Sunset, Moon } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import useGreeting from "../../core/hooks/useGreeting";
import styles from "./HeaderGreeting.module.css";

const PERIOD_ICON = {
  morning: Sunrise,
  afternoon: Sun,
  evening: Sunset,
  night: Moon,
};

// Ported from PROSM Platform's own Header/HeaderGreeting (§ visual
// consistency pass, item 3 - "PROSM-style welcome/greeting text").
// Bordered pill matching HeaderNavControls' own form, rather than
// bare floating text.
function HeaderGreeting() {
  const { profile } = useAuth();
  const { period, label } = useGreeting();

  const displayName = profile?.fullName ?? "";
  const Icon = PERIOD_ICON[period] ?? Sun;

  return (
    <div className={styles.greeting} data-period={period}>
      <Icon size={16} className={styles.icon} aria-hidden="true" />
      <span className={styles.text}>
        {label}
        {displayName ? `, ${displayName}` : ""}
      </span>
    </div>
  );
}

export default memo(HeaderGreeting);
