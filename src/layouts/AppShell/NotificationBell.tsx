import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Bell } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import NotificationRepository, { type AppNotification } from "../../core/repositories/NotificationRepository";
import { formatDateTime } from "../../core/utils/formatDate";
import playAlertSound from "../../core/utils/playAlertSound";
import playSirenSound from "../../core/utils/playSirenSound";
import localizeNotification from "../../core/utils/localizeNotification";
import notificationTarget from "../../core/utils/notificationTarget";
import SosAlertOverlay from "./SosAlertOverlay";
import styles from "./NotificationBell.module.css";

const SOS_SIREN_SECONDS = 30;

// § live UX review, user-directed - "clicking a notification should
// take me to the thing it needs". Owner 2026-10-20: the page comes from
// notificationTarget, shared with push notifications (the two disagreed);
// the bell adds the exact record where a page can focus it (an SOS alert
// on the Emergency Log, the employee's pending exception on the dashboard).

// PROSM Time WP-13/§20 - real notification bell, the entry point §20's
// own notification types (out-of-zone, exceptions, corrections, break
// overrun, SOS) surface at. Polls every 60s rather than a live
// subscription - simple, real, sufficient for this pass; a realtime
// channel is a genuine future refinement, not built here.
export default function NotificationBell() {
  const { t, i18n } = useTranslation("shell");
  const { profile, hasPermission } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  // Tracks IDs already seen across polls so a fresh poll can tell which
  // rows are genuinely new (and should play a sound) apart from rows
  // that only changed readAt. undefined until the first poll resolves,
  // so the very first load of the session never itself sounds an alert.
  const seenIdsRef = useRef<Set<string> | undefined>(undefined);

  // § live UX review, user-directed - "SOS shouldn't just be a
  // notification - a continuous siren for 10 seconds, and a siren
  // image on screen for the Admin/Owner." activeSosAlert drives
  // SosAlertOverlay below; sirenStopRef/sirenTimeoutRef let a later
  // dismiss (or a fresh SOS arriving mid-siren) cut the current one
  // short instead of letting two overlap.
  const [activeSosAlert, setActiveSosAlert] = useState<AppNotification | null>(null);
  const sirenStopRef = useRef<(() => void) | null>(null);
  const sirenTimeoutRef = useRef<number | null>(null);

  const clearSiren = useCallback(() => {
    if (sirenTimeoutRef.current !== null) {
      window.clearTimeout(sirenTimeoutRef.current);
      sirenTimeoutRef.current = null;
    }
    if (sirenStopRef.current) {
      sirenStopRef.current();
      sirenStopRef.current = null;
    }
  }, []);

  const triggerSosAlert = useCallback(
    (notification: AppNotification) => {
      clearSiren();
      setActiveSosAlert(notification);
      const handle = playSirenSound(SOS_SIREN_SECONDS);
      sirenStopRef.current = handle.stop;
      sirenTimeoutRef.current = window.setTimeout(() => {
        clearSiren();
        setActiveSosAlert(null);
      }, SOS_SIREN_SECONDS * 1000);
    },
    [clearSiren],
  );

  useEffect(() => () => clearSiren(), [clearSiren]);

  const load = useCallback(async () => {
    if (!profile) return;
    const result = await NotificationRepository.listRecent();
    const list = result.success ? result.data ?? [] : [];
    setNotifications(list);

    if (seenIdsRef.current) {
      const newOnes = list.filter((notification) => !seenIdsRef.current!.has(notification.id));
      const newSosAlert = newOnes.find((notification) => notification.type === "sos_alert");
      if (newSosAlert) {
        triggerSosAlert(newSosAlert);
      } else if (newOnes.length > 0) {
        playAlertSound();
      }
    }
    seenIdsRef.current = new Set(list.map((notification) => notification.id));
  }, [profile, triggerSosAlert]);

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

  const viewer = { isOwner: profile.isOwner, canViewEmergencyLog: hasPermission("attendance.view") };
  const targetOf = (notification: AppNotification) => {
    const path = notificationTarget({ type: notification.type, entityType: notification.relatedEntityType, kind: notification.data?.kind }, viewer);
    if (!notification.relatedEntityId) return path;
    if (path === "/emergency-log") return `/emergency-log?alertId=${notification.relatedEntityId}`;
    if (notification.type === "out_of_zone_employee") return `/dashboard?exceptionId=${notification.relatedEntityId}`;
    return path;
  };

  const handleSelect = async (notification: AppNotification) => {
    if (!notification.readAt) {
      await NotificationRepository.markRead(notification.id);
      load();
    }
    setOpen(false);
    navigate(targetOf(notification));
  };

  const handleDismissSos = () => {
    clearSiren();
    setActiveSosAlert(null);
  };

  const handleViewSos = async () => {
    const notification = activeSosAlert;
    if (!notification) return;
    clearSiren();
    setActiveSosAlert(null);
    if (!notification.readAt) {
      await NotificationRepository.markRead(notification.id);
      load();
    }
    navigate(targetOf(notification));
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
            notifications.map((notification) => {
              const localized = localizeNotification(notification, t);
              return (
                <button key={notification.id} type="button" className={`${styles.item} ${notification.readAt ? "" : styles.itemUnread}`} onClick={() => handleSelect(notification)}>
                  <span className={styles.itemTitle}>{localized.title}</span>
                  {localized.body ? <span className={styles.itemBody}>{localized.body}</span> : null}
                  <span className={styles.itemTime}>{formatDateTime(notification.createdAt, i18n.language)}</span>
                </button>
              );
            })
          )}
        </div>
      ) : null}

      {activeSosAlert ? (
        <SosAlertOverlay
          employeeName={typeof activeSosAlert.data?.employeeName === "string" ? activeSosAlert.data.employeeName : ""}
          onView={handleViewSos}
          onDismiss={handleDismissSos}
        />
      ) : null}
    </div>
  );
}
