import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { WifiOff } from "lucide-react";

import styles from "./OfflineBanner.module.css";

// PROSM Time - § real bug, user-reported (2026-09-15): opening the app
// with dead/degraded connectivity left a totally blank screen with no
// signal anything was wrong - every card in this codebase follows the
// same "if (loading) return null" pattern, so a hung or failed load
// just renders nothing, forever. supabaseClient.ts's own fix (a global
// fetch timeout) stops requests from hanging forever; this banner is
// the other half - an honest, always-visible "you're offline" signal
// so a blank/empty card reads as "you're offline" instead of "this is
// broken." Same mounted-once-above-the-route-tree shape as
// InstallationStatusBanner.tsx/UpdateAvailableBanner.tsx.
export default function OfflineBanner() {
  const { t } = useTranslation("shell");
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  if (isOnline) return null;

  return (
    <div className={styles.banner}>
      <WifiOff size={16} />
      <span>{t("offline.message")}</span>
    </div>
  );
}
