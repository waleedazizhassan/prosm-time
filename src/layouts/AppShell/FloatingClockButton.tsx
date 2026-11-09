import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { LogIn, LogOut } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import styles from "./FloatingClockButton.module.css";

// The clock-in card keeps its last known state here (ClockInOutCard.tsx); read only, to label the button.
const CACHE_PREFIX = "prosm_time_clockinout_cache_v1_";

function readClockedIn(profileId: string | undefined): boolean {
  if (!profileId) return false;
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + profileId);
    return Boolean(raw && JSON.parse(raw)?.session);
  } catch {
    return false;
  }
}

// Owner 2026-11-09: "the clock-in and clock-out button floats" - on every page, for whoever clocks in
// (never the owner), it takes them to their clock-in screen; hidden where that screen already is.
export default function FloatingClockButton() {
  const { t } = useTranslation("dashboard");
  const { profile, hasPermission } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [clockedIn, setClockedIn] = useState(() => readClockedIn(profile?.id));

  useEffect(() => {
    setClockedIn(readClockedIn(profile?.id));
    const onStorage = () => setClockedIn(readClockedIn(profile?.id));
    window.addEventListener("storage", onStorage);
    const timer = window.setInterval(onStorage, 15000);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.clearInterval(timer);
    };
  }, [profile?.id, location.pathname]);

  if (!profile || profile.isOwner) return null;
  // managers and supervisors clock in from their own page; employees from their home
  const target = hasPermission("attendance.view") ? "/clock-in" : "/dashboard";
  if (location.pathname === target || location.pathname.startsWith("/kiosk")) return null;

  return (
    <button type="button" className={`${styles.fab} ${clockedIn ? styles.out : styles.in}`} onClick={() => navigate(target)}
      aria-label={clockedIn ? t("attendance.clockOutAction") : t("attendance.clockInAction")}>
      {clockedIn ? <LogOut size={20} /> : <LogIn size={20} />}
      <span>{clockedIn ? t("attendance.clockOutAction") : t("attendance.clockInAction")}</span>
    </button>
  );
}
