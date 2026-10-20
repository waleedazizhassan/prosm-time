import { useCallback, useEffect, useRef, useState } from "react";

import { BUILD_RELEASED_AT } from "../buildInfo";

// Owner 2026-10-20: a new version is noticed within half an hour, and as
// soon as the app is opened again or comes back to the front (was 6 hours).
const SYNC_INTERVAL_MS = 30 * 60 * 1000;
const RECHECK_ON_RETURN_MS = 5 * 60 * 1000;

// release.yml commits this manifest to public/latest-version.json on
// every real release, and sets VITE_UPDATE_MANIFEST_URL to its
// raw.githubusercontent.com URL - a real, no-auth-required public URL
// now that the repo is public. Known, permanent limitation: VITE_*
// values are baked in at BUILD TIME, so this poll only works in a
// build compiled AFTER that env var was added - an already-installed
// older binary has no way to retroactively gain the ability to check
// for updates.
const MANIFEST_URL = import.meta.env.VITE_UPDATE_MANIFEST_URL ?? "";

export interface ReleaseManifest {
  version: string;
  releasedAt: string;
  downloads: { windows: string; android: string; web: string };
}

// PROSM Time - § user-directed, 2026-09-13: "the automatic banner
// isn't reliably reaching people - let's also have a real 'Check for
// update' button." Extracted out of UpdateAvailableBanner.tsx (which
// still owns the periodic background poll + its own small banner) so
// UserMenu.tsx's new manual button can share the exact same manifest-
// fetch/compare logic instead of a second, drifting copy.
//
// checkNow() always resolves to a real outcome - "up to date" (isStale
// false) is a genuine, reportable result here, unlike the background
// poll's own silent-on-failure posture (a manual check the user just
// asked for should never leave them wondering whether anything
// actually happened).
export function useUpdateCheck() {
  const [manifest, setManifest] = useState<ReleaseManifest | null>(null);
  const [checking, setChecking] = useState(false);
  const cancelledRef = useRef(false);

  const checkNow = useCallback(async (): Promise<{ success: boolean; isStale: boolean; manifest: ReleaseManifest | null }> => {
    if (!MANIFEST_URL) return { success: false, isStale: false, manifest: null };
    setChecking(true);
    try {
      const response = await fetch(MANIFEST_URL, { cache: "no-store" });
      if (!response.ok) return { success: false, isStale: false, manifest: null };
      const data: ReleaseManifest = await response.json();
      const isStale = Boolean(data?.releasedAt && BUILD_RELEASED_AT && new Date(data.releasedAt).getTime() > new Date(BUILD_RELEASED_AT).getTime());
      if (!cancelledRef.current) setManifest(isStale ? data : null);
      return { success: true, isStale, manifest: data };
    } catch {
      return { success: false, isStale: false, manifest: null };
    } finally {
      if (!cancelledRef.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    checkNow();
    const interval = setInterval(checkNow, SYNC_INTERVAL_MS);
    let lastCheck = Date.now();
    const onReturn = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastCheck < RECHECK_ON_RETURN_MS) return;
      lastCheck = Date.now();
      checkNow();
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      cancelledRef.current = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [checkNow]);

  return { manifest, checking, checkNow, canCheck: Boolean(MANIFEST_URL) };
}
