import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "../../core/context/AuthContext";
import PresenceRepository, { type PresenceSession } from "../../core/repositories/PresenceRepository";
import BackgroundLocationService from "../../core/services/BackgroundLocationService";
import { getCurrentPosition } from "../../core/utils/geo";
import playAlertSound from "../../core/utils/playAlertSound";

const PRESENCE_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
// Cheap "is a presence session active right now" recheck - much
// shorter than the sample interval so a fresh Clock In (which starts a
// new presence session) is picked up quickly, without paying the
// GPS-capture cost of a real sample every time.
const PRESENCE_SESSION_POLL_MS = 30 * 1000;

// PROSM Time - real bug, user-reported: presence sampling used to live
// entirely inside ClockInOutCard.tsx (the Dashboard's own clock-in
// widget) - the moment an employee navigated to ANY other page in the
// app, that component unmounted, its interval was cleared, and no more
// location samples were ever submitted for the rest of that shift.
// Someone could walk straight out of their geofence right after
// checking their own Leave page and nothing would ever notice - no
// exception, no notification to them, their manager, or the Owner,
// exactly the reported symptom. Presence tracking's own original
// design comment already said "tab must stay open" (i.e. the whole
// app session, not one specific screen) - this was always the intent,
// just never actually hoisted to the app-shell level where it holds
// for the whole session regardless of which page is showing. Mounted
// once in AppShell/index.tsx, same always-alive pattern as
// InstallationStatusBanner/UpdateAvailableBanner.
//
// § user-directed, 2026-09-13 - real background operation, with the
// user's own consent: on native platforms (the Android app), a real
// background-location watcher (BackgroundLocationService, backed by
// @capacitor-community/background-geolocation) now takes over from the
// plain JS interval below the moment a presence session is active - it
// keeps delivering samples while the app is fully backgrounded (screen
// locked, another app in front), covered by Android's own visible,
// always-cancellable tracking notification and its own two-step
// foreground/background location consent dialogs. The JS-interval path
// remains exactly as it was for the web build, where no such native
// capability exists - foreground-tab sampling only, same disclosed
// limitation as before there.
export default function PresenceTrackingLoop() {
  const { profile } = useAuth();
  const { t } = useTranslation("shell");
  const presenceSessionRef = useRef<PresenceSession | null>(null);
  const [activePresenceSessionId, setActivePresenceSessionId] = useState<string | null>(null);

  // Keeps activePresenceSessionId (and the ref every sampling path
  // reads from) in sync with the real server-side state - both the
  // native and web sampling paths below react to this, they never
  // poll for the session themselves.
  useEffect(() => {
    if (!profile) return undefined;
    let cancelled = false;

    const checkForActiveSession = async () => {
      const result = await PresenceRepository.getActiveSession(profile.id);
      if (cancelled) return;
      const session = result.success ? result.data ?? null : null;
      presenceSessionRef.current = session;
      setActivePresenceSessionId(session?.id ?? null);
    };

    checkForActiveSession();
    const pollInterval = setInterval(checkForActiveSession, PRESENCE_SESSION_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(pollInterval);
    };
  }, [profile]);

  const recordSample = async (latitude: number, longitude: number, accuracyMeters: number | null) => {
    const current = presenceSessionRef.current;
    if (!current) return;
    const result = await PresenceRepository.recordSample(current.id, latitude, longitude, accuracyMeters);
    if (result.success && result.data?.exceptionCreated) playAlertSound();
  };

  // Native path - real background tracking.
  useEffect(() => {
    if (!BackgroundLocationService.isSupported()) return undefined;
    if (!activePresenceSessionId) return undefined;

    BackgroundLocationService.start(t("backgroundTrackingTitle"), t("backgroundTrackingMessage"), (latitude, longitude, accuracyMeters) => {
      recordSample(latitude, longitude, accuracyMeters);
    });

    return () => {
      BackgroundLocationService.stop();
    };
  }, [activePresenceSessionId, t]);

  // Web fallback path - foreground-tab-only JS interval, unchanged
  // from before. Skipped entirely on native, where the background
  // watcher above already covers both foreground and background.
  useEffect(() => {
    if (BackgroundLocationService.isSupported()) return undefined;
    if (!activePresenceSessionId) return undefined;

    const sampleInterval = setInterval(async () => {
      try {
        const position = await getCurrentPosition();
        await recordSample(position.latitude, position.longitude, position.accuracyMeters);
      } catch {
        // Best-effort only - a failed/denied sample never surfaces as
        // an error, matching every other geolocation capture in this
        // app.
      }
    }, PRESENCE_SAMPLE_INTERVAL_MS);

    return () => clearInterval(sampleInterval);
  }, [activePresenceSessionId]);

  return null;
}
