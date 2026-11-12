import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Bell } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";
import NotificationRepository, { type AppNotification } from "../../core/repositories/NotificationRepository";
import { formatDateTime } from "../../core/utils/formatDate";
import playNotificationSound from "../../core/utils/playNotificationSound";
import playBuzzSound, { vibrateBuzz } from "../../core/utils/playBuzzSound";
import playSirenSound from "../../core/utils/playSirenSound";
import localizeNotification from "../../core/utils/localizeNotification";
import notificationTarget from "../../core/utils/notificationTarget";
import SosAlertOverlay from "./SosAlertOverlay";
import { NOTIFICATION_ARRIVED_EVENT } from "../../core/services/PushService";
import { requireSupabaseClient } from "../../core/api/supabaseClient";
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
// SOS alerts already sounded on this device (kept across app restarts).
const SOS_ALERTED_KEY = "prosm_time_sos_alerted_v1";
const SOS_FRESH_MS = 30 * 60 * 1000;
function wasSosAlerted(id: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(SOS_ALERTED_KEY) ?? "[]") as string[]).includes(id);
  } catch {
    return false;
  }
}
function rememberSosAlerted(id: string): void {
  try {
    const ids = (JSON.parse(localStorage.getItem(SOS_ALERTED_KEY) ?? "[]") as string[]).filter((existing) => existing !== id);
    localStorage.setItem(SOS_ALERTED_KEY, JSON.stringify([id, ...ids].slice(0, 50)));
  } catch {
    // storage unavailable - the read and freshness checks still apply
  }
}

const TOAST_MS = 5000;

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
  const [sosSilenced, setSosSilenced] = useState(false);
  const [sosLocating, setSosLocating] = useState(false);
  const [sosNoLocation, setSosNoLocation] = useState(false);
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
      setSosSilenced(false);
      setSosNoLocation(false);
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
  const [toasts, setToasts] = useState<AppNotification[]>([]);

  const load = useCallback(async () => {
    if (!profile) return;
    const result = await NotificationRepository.listRecent();
    // Owner 2026-10-20 ("the emergency alarm comes back every time I open the app"):
    // a failed read used to count as "no notifications", so the next good read
    // treated every old one as new and replayed an SOS from hours before. A failed
    // read now changes nothing.
    if (!result.success) return;
    const list = result.data ?? [];
    setNotifications(list);

    if (seenIdsRef.current) {
      const newOnes = list.filter((notification) => !seenIdsRef.current!.has(notification.id));
      // An SOS sounds once, while it is fresh and unread - never again on this device.
      const newSosAlert = newOnes.find(
        (notification) =>
          notification.type === "sos_alert" &&
          notification.readAt === null &&
          Date.now() - new Date(notification.createdAt).getTime() < SOS_FRESH_MS &&
          !wasSosAlerted(notification.id),
      );
      if (newSosAlert) {
        rememberSosAlerted(newSosAlert.id);
        triggerSosAlert(newSosAlert);
      } else {
        // Owner 2026-11-10: a new notification plays PROSM's own chime and shows for 5 seconds at the
        // top of the screen - above everything, the full-screen map too
        const fresh = newOnes.filter((notification) => notification.type !== "sos_alert" && notification.readAt === null);
        if (fresh.length > 0) {
          // a Buzz vibrates and plays the buzzer; anything else plays the chime
          if (fresh.some((notification) => notification.type === "buzz")) {
            vibrateBuzz();
            playBuzzSound();
          } else {
            playNotificationSound();
          }
          setToasts((current) => [...fresh.slice(0, 3), ...current].slice(0, 3));
          for (const notification of fresh.slice(0, 3)) {
            window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== notification.id)), TOAST_MS);
          }
        }
      }
    }
    seenIdsRef.current = new Set(list.map((notification) => notification.id));
  }, [profile, triggerSosAlert]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, [load]);

  // Owner 2026-11-10 (Buzz): a new notification shows at once, not at the next minute - from the
  // database's live feed of this person's notifications, and from a push arriving while the app is open
  const profileId = profile?.id;
  useEffect(() => {
    if (!profileId) return undefined;
    const onArrived = () => load();
    window.addEventListener(NOTIFICATION_ARRIVED_EVENT, onArrived);
    let channel: ReturnType<ReturnType<typeof requireSupabaseClient>["channel"]> | null = null;
    try {
      channel = requireSupabaseClient()
        .channel(`notifications-${profileId}`)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${profileId}` }, onArrived)
        .subscribe();
    } catch {
      // no live feed: the minute check still runs
    }
    return () => {
      window.removeEventListener(NOTIFICATION_ARRIVED_EVENT, onArrived);
      if (channel) void channel.unsubscribe();
    };
  }, [profileId, load]);

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
    const path = notificationTarget({ type: notification.type, entityType: notification.relatedEntityType, entityId: notification.relatedEntityId, kind: notification.data?.kind, date: notification.data?.date }, viewer);
    if (!notification.relatedEntityId) return path;
    if (path === "/emergency-log") return `/emergency-log?alertId=${notification.relatedEntityId}`;
    if (notification.type === "out_of_zone_employee") return `/exceptions?exceptionId=${notification.relatedEntityId}`;
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
    setSosSilenced(false);
    setSosNoLocation(false);
  };

  // owner 2026-11-12: silence stops the siren and keeps the alert on screen until it is closed
  const handleSilenceSos = () => {
    clearSiren();
    setSosSilenced(true);
  };

  // owner 2026-11-12: the alert's position on the map, for everyone it reached
  const handleSosLocation = async () => {
    const notification = activeSosAlert;
    if (!notification?.relatedEntityId) return setSosNoLocation(true);
    setSosLocating(true);
    const where = await NotificationRepository.getSosLocation(notification.relatedEntityId);
    setSosLocating(false);
    if (!where) return setSosNoLocation(true);
    window.open(`https://www.google.com/maps?q=${where.latitude},${where.longitude}`, "_blank", "noopener");
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

      {toasts.length > 0
        ? createPortal(
            <div className={styles.toasts} role="status" aria-live="polite">
              {toasts.map((notification) => {
                const localized = localizeNotification(notification, t);
                return (
                  <button key={notification.id} type="button" className={notification.type === "buzz" ? `${styles.toast} ${styles.toastBuzz}` : styles.toast}
                    onClick={() => { setToasts((current) => current.filter((item) => item.id !== notification.id)); handleSelect(notification); }}>
                    <span className={styles.toastIcon} aria-hidden="true"><Bell size={16} /></span>
                    <span className={styles.toastText}>
                      <span className={styles.itemTitle}>{localized.title}</span>
                      {localized.body ? <span className={styles.itemBody}>{localized.body}</span> : null}
                    </span>
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}

      {activeSosAlert ? (
        <SosAlertOverlay
          employeeName={typeof activeSosAlert.data?.employeeName === "string" ? activeSosAlert.data.employeeName : ""}
          onView={viewer.isOwner || viewer.canViewEmergencyLog ? handleViewSos : null}
          onShowLocation={() => void handleSosLocation()}
          locating={sosLocating}
          noLocation={sosNoLocation}
          onSilence={handleSilenceSos}
          silenced={sosSilenced}
          onDismiss={handleDismissSos}
        />
      ) : null}
    </div>
  );
}
