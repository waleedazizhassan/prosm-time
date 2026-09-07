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
import SosAlertOverlay from "./SosAlertOverlay";
import styles from "./NotificationBell.module.css";

const SOS_SIREN_SECONDS = 30;

// § live UX review, user-directed - "clicking a notification should
// take me to the thing it needs" (e.g. something awaiting approval
// should open the approval screen). Every real notification type maps
// to the one screen where its underlying record is actually reviewed/
// acted on; a type with no dedicated action screen just goes to the
// Dashboard rather than nowhere.
//
// § live UX review, user-directed - "an SOS alert should go to a real
// Emergency Log, not the Manager Console" - sos_alert now routes to
// /emergency-log (with its own alertId appended by handleSelect/
// handleViewSos below, this bare fallback only fires if a stored
// notification is somehow missing its relatedEntityId).
function notificationRoute(type: string): string {
  switch (type) {
    case "exception_pending_review":
    case "out_of_zone_manager":
      return "/manager";
    case "sos_alert":
      return "/emergency-log";
    case "out_of_zone_employee":
    case "correction_reviewed":
    case "break_exceeded":
    default:
      return "/dashboard";
  }
}

// PROSM Time WP-13/§20 - real notification bell, the entry point §20's
// own notification types (out-of-zone, exceptions, corrections, break
// overrun, SOS) surface at. Polls every 60s rather than a live
// subscription - simple, real, sufficient for this pass; a realtime
// channel is a genuine future refinement, not built here.
export default function NotificationBell() {
  const { t, i18n } = useTranslation("shell");
  const { profile } = useAuth();
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

  const handleSelect = async (notification: AppNotification) => {
    if (!notification.readAt) {
      await NotificationRepository.markRead(notification.id);
      load();
    }
    setOpen(false);
    if (notification.type === "sos_alert" && notification.relatedEntityId) {
      navigate(`/emergency-log?alertId=${notification.relatedEntityId}`);
      return;
    }
    navigate(notificationRoute(notification.type));
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
    navigate(notification.relatedEntityId ? `/emergency-log?alertId=${notification.relatedEntityId}` : "/emergency-log");
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
