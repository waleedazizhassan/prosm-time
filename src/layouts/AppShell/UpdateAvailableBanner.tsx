import { useTranslation } from "react-i18next";
import { Capacitor } from "@capacitor/core";
import { Download } from "lucide-react";

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
export default function UpdateAvailableBanner() {
  const { t } = useTranslation("shell");
  const { manifest } = useUpdateCheck();

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
