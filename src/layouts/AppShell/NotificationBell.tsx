import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bell } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import NotificationRepository, { type AppNotification } from "../../core/repositories/NotificationRepository";
import { formatDateTime } from "../../core/utils/formatDate";
import playAlertSound from "../../core/utils/playAlertSound";
import styles from "./NotificationBell.module.css";

// PROSM Time WP-13/§20 - real notification bell, the entry point §20's
// own notification types (out-of-zone, exceptions, corrections, break
// overrun, SOS) surface at. Polls every 60s rather than a live
// subscription - simple, real, sufficient for this pass; a realtime
// channel is a genuine future refinement, not built here.
export default function NotificationBell() {
  const { t, i18n } = useTranslation("shell");
  const { profile } = useAuth();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  // Tracks IDs already seen across polls so a fresh poll can tell which
  // rows are genuinely new (and should play a sound) apart from rows
  // that only changed readAt. undefined until the first poll resolves,
  // so the very first load of the session never itself sounds an alert.
  const seenIdsRef = useRef<Set<string> | undefined>(undefined);

  const load = useCallback(async () => {
    if (!profile) return;
    const result = await NotificationRepository.listRecent();
    const list = result.success ? result.data ?? [] : [];
    setNotifications(list);

    const currentIds = new Set(list.map((notification) => notification.id));
    if (seenIdsRef.current) {
      const hasNew = list.some((notification) => !seenIdsRef.current!.has(notification.id));
      if (hasNew) playAlertSound();
    }
    seenIdsRef.current = currentIds;
  }, [profile]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    if (!open) return undefined;
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  if (!profile) return null;

  const unreadCount = notifications.filter((notification) => !notification.readAt).length;

  const handleSelect = async (notification: AppNotification) => {
    if (!notification.readAt) {
      await NotificationRepository.markRead(notification.id);
      load();
    }
  };

  return (
    <div ref={containerRef} className={styles.container}>
      <button type="button" className={styles.trigger} onClick={() => setOpen((current) => !current)} aria-haspopup="dialog" aria-expanded={open} aria-label={t("notificationsLabel")}>
        <Bell size={18} />
        {unreadCount > 0 ? <span className={styles.badge}>{unreadCount > 9 ? "9+" : unreadCount}</span> : null}
      </button>

      {open ? (
        <div className={styles.panel} role="dialog">
          <div className={styles.panelHeader}>{t("notificationsLabel")}</div>
          {notifications.length === 0 ? (
            <p className={styles.empty}>{t("noNotifications")}</p>
          ) : (
            notifications.map((notification) => (
              <button key={notification.id} type="button" className={`${styles.item} ${notification.readAt ? "" : styles.itemUnread}`} onClick={() => handleSelect(notification)}>
                <span className={styles.itemTitle}>{notification.title}</span>
                {notification.body ? <span className={styles.itemBody}>{notification.body}</span> : null}
                <span className={styles.itemTime}>{formatDateTime(notification.createdAt, i18n.language)}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
