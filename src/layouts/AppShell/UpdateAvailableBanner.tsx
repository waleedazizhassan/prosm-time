import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { ensureAlertChannel, NOTIFICATION_STYLE } from "../../core/services/notificationStyle";
import { Download } from "lucide-react";
import { AppUpdate, AppUpdateAvailability } from "@capawesome/capacitor-app-update";

import { useUpdateCheck } from "../../core/hooks/useUpdateCheck";
import styles from "./UpdateAvailableBanner.module.css";

// PROSM Time - user-directed: "any real update should notify the user
// with a real go-to button." Mirrors InstallationStatusBanner.tsx's
// exact established shape (periodic poll, small non-intrusive banner,
// mounted once above the whole route tree) - polls a public static
// manifest instead of a Supabase RPC, since there's no session/org
// concept involved in "is a newer build published." The actual poll/
// compare logic lives in useUpdateCheck.ts, shared with UserMenu's own
// manual "Check for update" button (2026-09-13 - the background poll
// alone wasn't reliably reaching people, so a real on-demand check
// exists too now).
//
// The button's destination is platform-specific: on Android it opens
// the manifest's real APK download URL; on web/Electron it reloads
// this page (a Pages deploy is already live the moment the workflow
// finishes - "updating" a web client is just a fresh load) - Electron
// itself has no auto-update wiring yet, so its own button instead
// opens the Windows installer download like the web fallback does,
// since a reload cannot update a locally-installed desktop binary.
const UPDATE_NOTICE_ID = 7101;

// v2.3.44 (owner 2026-10-26: "the app is too long, I can't reach the
// notifications"): inside the app the notice sits under the header with the
// other notices (it no longer adds a bar above a full-screen app);
// before sign-in it stays at the top, below the phone's status bar.
export default function UpdateAvailableBanner({ placement = "top" }: { placement?: "top" | "shell" }) {
  // Owner 2026-11-09: the Google Play build is told about an update too - by Google Play itself
  // (in-app updates), so the notice appears only when Play really has the new version.
  if (import.meta.env.VITE_DISTRIBUTION === "play") return <PlayUpdateBanner placement={placement} />;
  return <SelfUpdateBanner placement={placement} />;
}

const PLAY_URL = "https://play.google.com/store/apps/details?id=net.prosm.time";
const PLAY_RECHECK_MS = 30 * 60 * 1000;

function PlayUpdateBanner({ placement }: { placement: "top" | "shell" }) {
  const { t } = useTranslation("shell");
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return undefined;
    let live = true;
    const check = async () => {
      try {
        const info = await AppUpdate.getAppUpdateInfo();
        if (!live) return;
        const available = info.updateAvailability === AppUpdateAvailability.UPDATE_AVAILABLE;
        setVersion(available ? info.availableVersionName ?? info.availableVersionCode ?? "" : null);
      } catch {
        // not installed from Google Play (or Play unreachable): no notice
        if (live) setVersion(null);
      }
    };
    void check();
    const interval = window.setInterval(() => void check(), PLAY_RECHECK_MS);
    const onReturn = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      live = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, []);

  // the same phone notification as the other builds, until the update is installed
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    void (async () => {
      try {
        await LocalNotifications.cancel({ notifications: [{ id: UPDATE_NOTICE_ID }] });
        if (version === null) return;
        const permission = await LocalNotifications.checkPermissions();
        if (permission.display !== "granted") return;
        await ensureAlertChannel();
        await LocalNotifications.schedule({
          notifications: [{ id: UPDATE_NOTICE_ID, title: t("update.noticeTitle"), body: version ? t("update.available", { version }) : t("update.availablePlay"), autoCancel: true, ...NOTIFICATION_STYLE }],
        });
      } catch (error) {
        console.warn("[update] could not show the update notification", error);
      }
    })();
  }, [version, t]);

  if (version === null) return null;

  // Google Play's own update screen; if it cannot run, the store page
  const handleUpdate = async () => {
    try {
      await AppUpdate.performImmediateUpdate();
    } catch {
      try {
        await AppUpdate.openAppStore();
      } catch {
        window.open(PLAY_URL, "_blank", "noopener,noreferrer");
      }
    }
  };

  return (
    <div className={placement === "shell" ? `${styles.banner} ${styles.inShell}` : styles.banner} role="status">
      <Download size={16} />
      <span>{version ? t("update.available", { version }) : t("update.availablePlay")}</span>
      <button type="button" className={styles.action} onClick={() => void handleUpdate()}>
        {t("update.action")}
      </button>
    </div>
  );
}

function SelfUpdateBanner({ placement }: { placement: "top" | "shell" }) {
  const { t } = useTranslation("shell");
  const { manifest } = useUpdateCheck();
  const pendingVersion = manifest?.version ?? null;

  // Owner 2026-10-20: on the phone, a notification stays in the notification
  // bar until the app is updated (it goes as soon as this build is the
  // newest); tapping it opens the app, where this banner's button downloads
  // the update. v2.3.43 step 19 (item 13): it can now be swiped away.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const run = async () => {
      try {
        await LocalNotifications.cancel({ notifications: [{ id: UPDATE_NOTICE_ID }] });
        if (!pendingVersion) return;
        const permission = await LocalNotifications.checkPermissions();
        if (permission.display !== "granted") return;
        await ensureAlertChannel();
        await LocalNotifications.schedule({
          notifications: [{ id: UPDATE_NOTICE_ID, title: t("update.noticeTitle"), body: t("update.available", { version: pendingVersion }), autoCancel: true, ...NOTIFICATION_STYLE }],
        });
      } catch (error) {
        // notifications unavailable - the banner still shows
        console.warn("[update] could not show the update notification", error);
      }
    };
    void run();
  }, [pendingVersion, t]);

  if (!manifest) return null;

  const isAndroid = Capacitor.isNativePlatform();

  const handleUpdate = () => {
    if (isAndroid) {
      window.open(manifest.downloads.android, "_blank", "noopener,noreferrer");
      return;
    }
    if (window.location.protocol.startsWith("http")) {
      // 2026-11-09: a fresh page, not the browser's saved copy (the notice used to stay after updating)
      void (async () => {
        try {
          const registration = await navigator.serviceWorker?.getRegistration();
          await registration?.update();
        } catch {
          // no service worker: the address below is enough
        }
        const url = new URL(window.location.href);
        url.searchParams.set("v", String(Date.now()));
        window.location.replace(url.toString());
      })();
      return;
    }
    // Electron (file:///app:// protocol) - can't self-update by reload,
    // point at the installer download instead.
    window.open(manifest.downloads.windows, "_blank", "noopener,noreferrer");
  };

  return (
    <div className={placement === "shell" ? `${styles.banner} ${styles.inShell}` : styles.banner} role="status">
      <Download size={16} />
      <span>{t("update.available", { version: manifest.version })}</span>
      <button type="button" className={styles.action} onClick={handleUpdate}>
        {t("update.action")}
      </button>
    </div>
  );
}
