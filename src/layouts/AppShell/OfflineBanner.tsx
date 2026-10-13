import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import offlineArt from "../../assets/illustrations/state-offline.svg";
import onlineArt from "../../assets/illustrations/state-online.svg";
import styles from "./OfflineBanner.module.css";

const BACK_ONLINE_MS = 4000;

// Offline notice (owner 2026-10-13: kind messages with fitting pictures).
// While offline: a small card saying attendance still works and will be
// sent later. When the connection returns: a short "back online" note.
export default function OfflineBanner() {
  const { t } = useTranslation("shell");
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const [backOnline, setBackOnline] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      setBackOnline(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setBackOnline(false), BACK_ONLINE_MS);
    };
    const handleOffline = () => {
      setIsOnline(false);
      setBackOnline(false);
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  if (isOnline && !backOnline) return null;

  const offline = !isOnline;
  return (
    <div role="status" className={`${styles.banner} ${offline ? styles.offline : styles.online}`}>
      <img src={offline ? offlineArt : onlineArt} alt="" className={styles.art} />
      <div className={styles.text}>
        <strong className={styles.title}>{offline ? t("offline.title") : t("offline.backOnline")}</strong>
        {offline ? <span className={styles.message}>{t("offline.message")}</span> : null}
      </div>
    </div>
  );
}
