import { useEffect, useRef } from "react";

import { useAuth } from "../../core/context/AuthContext";
import PresenceRepository, { type PresenceSession } from "../../core/repositories/PresenceRepository";
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
// Still a real, disclosed limitation: this is a foreground-tab/app JS
// timer, not native background location - a fully backgrounded app
// (screen locked, app swapped away) still won't sample. Closing that
// gap for real needs native background-location capability (Capacitor
// Geolocation's background mode + a foreground service on Android),
// a separate, larger addition, not something this component can do on
// its own.
export default function PresenceTrackingLoop() {
  const { profile } = useAuth();
  const presenceSessionRef = useRef<PresenceSession | null>(null);

  useEffect(() => {
    if (!profile) return undefined;
    let cancelled = false;

    const checkForActiveSession = async () => {
      const result = await PresenceRepository.getActiveSession(profile.id);
      if (cancelled) return;
      presenceSessionRef.current = result.success ? result.data ?? null : null;
    };

    checkForActiveSession();
    const pollInterval = setInterval(checkForActiveSession, PRESENCE_SESSION_POLL_MS);

    const sampleInterval = setInterval(async () => {
      const current = presenceSessionRef.current;
      if (!current) return;
      try {
        const position = await getCurrentPosition();
        const result = await PresenceRepository.recordSample(current.id, position.latitude, position.longitude, position.accuracyMeters);
        if (result.success && result.data?.exceptionCreated) {
          playAlertSound();
        }
      } catch {
        // Best-effort only - a failed/denied sample never surfaces as
        // an error, matching every other geolocation capture in this
        // app.
      }
    }, PRESENCE_SAMPLE_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(pollInterval);
      clearInterval(sampleInterval);
    };
  }, [profile]);

  return null;
}
