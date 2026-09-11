import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Capacitor } from "@capacitor/core";
import { Download } from "lucide-react";

import { APP_VERSION } from "../../core/appVersion";
import { isVersionNewer } from "../../core/utils/compareVersions";
import styles from "./UpdateAvailableBanner.module.css";

const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // matches InstallationStatusBanner's own established polling cadence

// release.yml commits this manifest to public/latest-version.json on
// every real release, and (2026-09-11, once the repo went public for
// unrelated download-URL reasons) sets VITE_UPDATE_MANIFEST_URL to its
// raw.githubusercontent.com URL - now a real, no-auth-required public
// URL. Real, known limitation this fixed: VITE_* values are baked in
// at BUILD TIME, so this poll only works in a build compiled AFTER
// that env var was added - an already-installed older binary has no
// way to retroactively gain the ability to check for updates; only
// once a user is running a build with this wired in will they start
// seeing banners for whatever release comes after that one. A missing
// env var (local dev, or if this is ever unset again) degrades safely
// - a failed/404 fetch never shows a false "update available".
const MANIFEST_URL = import.meta.env.VITE_UPDATE_MANIFEST_URL ?? "";

interface ReleaseManifest {
  version: string;
  releasedAt: string;
  downloads: { windows: string; android: string; web: string };
}

// PROSM Time - user-directed: "any real update should notify the user
// with a real go-to button." Mirrors InstallationStatusBanner.tsx's
// exact established shape (periodic poll, small non-intrusive banner,
// AppShell-level placement) - this one polls a public static manifest
// instead of a Supabase RPC, since there's no session/org concept
// involved in "is a newer build published."
//
// The button's destination is platform-specific: on Android it opens
// the manifest's real APK download URL; on web/Electron it reloads
// this page (a Pages deploy is already live the moment the workflow
// finishes - "updating" a web client is just a fresh load) - Electron
// itself has no auto-update wiring yet, so its own button instead
// opens the Windows installer download like the web fallback does,
// since a reload cannot update a locally-installed desktop binary.
export default function UpdateAvailableBanner() {
  const { t } = useTranslation("shell");
  const [manifest, setManifest] = useState<ReleaseManifest | null>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      if (!MANIFEST_URL) return;
      try {
        const response = await fetch(MANIFEST_URL, { cache: "no-store" });
        if (!response.ok) return;
        const data: ReleaseManifest = await response.json();
        if (!cancelled && data?.version && isVersionNewer(data.version, APP_VERSION)) {
          setManifest(data);
        }
      } catch {
        // Offline, or the manifest isn't published yet - never treat
        // this as "an update is needed", only a real newer version
        // read from a real response does that.
      }
    };

    poll();
    const interval = setInterval(poll, SYNC_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (!manifest) return null;

  const isAndroid = Capacitor.isNativePlatform();

  const handleUpdate = () => {
    if (isAndroid) {
      window.open(manifest.downloads.android, "_blank", "noopener,noreferrer");
      return;
    }
    if (window.location.protocol.startsWith("http")) {
      window.location.reload();
      return;
    }
    // Electron (file:///app:// protocol) - can't self-update by reload,
    // point at the installer download instead.
    window.open(manifest.downloads.windows, "_blank", "noopener,noreferrer");
  };

  return (
    <div className={styles.banner}>
      <Download size={16} />
      <span>{t("update.available", { version: manifest.version })}</span>
      <button type="button" className={styles.action} onClick={handleUpdate}>
        {t("update.action")}
      </button>
    </div>
  );
}
