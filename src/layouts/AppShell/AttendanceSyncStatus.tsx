import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { RefreshCw, CloudOff, AlertTriangle } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import OfflineQueueService, { type OfflineQueueItem } from "../../core/offline/OfflineQueueService";
import styles from "./OfflineBanner.module.css";

// Offline attendance (owner 2026-09-29): the queue is sent from every screen, not only the
// dashboard - on app start, when the connection returns, and every 30 seconds - and a clear bar
// says how many attendance actions are still waiting, that they are being sent, or that one needs
// the worker's attention (a refusal by the server, kept until retried or discarded).
export default function AttendanceSyncStatus() {
  const { t } = useTranslation("shell");
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [items, setItems] = useState<OfflineQueueItem[]>([]);

  useEffect(() => OfflineQueueService.subscribe((all) => setItems(profile?.id ? all.filter((i) => i.userId === profile.id) : [])), [profile?.id]);

  useEffect(() => {
    const attempt = () => void OfflineQueueService.flush();
    attempt();
    window.addEventListener("online", attempt);
    const interval = setInterval(attempt, 30000);
    return () => {
      window.removeEventListener("online", attempt);
      clearInterval(interval);
    };
  }, []);

  if (items.length === 0) return null;
  const failed = items.some((i) => i.status === "failed");
  const syncing = items.some((i) => i.status === "syncing");
  return (
    <div className={styles.banner} role="status" style={{ cursor: "pointer" }} onClick={() => navigate("/dashboard")}>
      {failed ? <AlertTriangle size={16} /> : syncing ? <RefreshCw size={16} /> : <CloudOff size={16} />}
      <span>
        {failed
          ? t("offlineSync.failed", { count: items.length })
          : syncing
            ? t("offlineSync.syncing", { count: items.length })
            : t("offlineSync.waiting", { count: items.length })}
      </span>
    </div>
  );
}
