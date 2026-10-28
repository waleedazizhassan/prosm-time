import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "../../core/context/AuthContext";
import PresenceRepository, { type PresenceSession } from "../../core/repositories/PresenceRepository";
import BackgroundLocationService, { type TrackingFailure } from "../../core/services/BackgroundLocationService";
import { getCurrentPosition } from "../../core/utils/geo";
import playAlertSound from "../../core/utils/playAlertSound";
import Modal from "../../components/common/Modal";
import Button from "../../components/common/Button";
import { readBackgroundConsent, writeBackgroundConsent, STARTUP_PERMISSIONS_EVENT, type BackgroundConsent } from "../../core/services/StartupPermissions";

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
const EXIT_PROMPT_NOTIFICATION_ID = 7201;

async function notifyLeftSite(title: string, body: string) {
  try {
    const { Capacitor } = await import("@capacitor/core");
    if (!Capacitor.isNativePlatform()) return;
    const { LocalNotifications } = await import("@capacitor/local-notifications");
    const { ensureAlertChannel, NOTIFICATION_STYLE } = await import("../../core/services/notificationStyle");
    await ensureAlertChannel();
    await LocalNotifications.schedule({ notifications: [{ id: EXIT_PROMPT_NOTIFICATION_ID, title, body, ...NOTIFICATION_STYLE }] });
  } catch {
    // no permission or plugin: the in-app question on the dashboard still shows
  }
}

const TRACKING_RETRY_MS = 30_000;

export default function PresenceTrackingLoop() {
  const { profile } = useAuth();
  const { t } = useTranslation("shell");
  // The exit notification's texts, read from a ref so recordSample stays stable for the tracking effects.
  const tRef = useRef(t);
  tRef.current = t;
  const presenceSessionRef = useRef<PresenceSession | null>(null);
  const [activePresenceSessionId, setActivePresenceSessionId] = useState<string | null>(null);
  // Prominent disclosure before background location (owner 2026-10-13,
  // Google Play policy): asked once; the answer is remembered on the device.
  const [backgroundConsent, setBackgroundConsent] = useState<BackgroundConsent>(readBackgroundConsent);
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const [trackingFailure, setTrackingFailure] = useState<TrackingFailure | null>(null);
  const [trackingAttempt, setTrackingAttempt] = useState(0);

  const answerDisclosure = (answer: "accepted" | "declined") => {
    writeBackgroundConsent(answer);
    setBackgroundConsent(answer);
    setDisclosureOpen(false);
  };

  // Accepted on the start screen (StartupPermissions): not asked again at clock-in.
  useEffect(() => {
    const sync = () => setBackgroundConsent(readBackgroundConsent());
    window.addEventListener(STARTUP_PERMISSIONS_EVENT, sync);
    return () => window.removeEventListener(STARTUP_PERMISSIONS_EVENT, sync);
  }, []);

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
    // v2.3.43 step 12 (item 24): "You left the site - clock out?" on the phone at once,
    // even without push (the server asks once per time outside).
    if (result.success && result.data?.exitPrompted) void notifyLeftSite(tRef.current("exitPrompt.title"), tRef.current("exitPrompt.body"));
  };

  // Native path - real background tracking, only after the in-app
  // disclosure has been accepted (Google Play requires a prominent
  // disclosure before background location is requested).
  useEffect(() => {
    if (!BackgroundLocationService.isSupported()) return undefined;
    if (!activePresenceSessionId) return undefined;
    if (backgroundConsent !== "accepted") {
      if (backgroundConsent === "unknown") setDisclosureOpen(true);
      return undefined;
    }

    // v2.3.43 step 19 (item 13): a failure is shown, and a service failure is retried once.
    let retryTimer: number | undefined;
    let stopped = false;
    const begin = async (attempt: number) => {
      const fail = (reason: TrackingFailure) => {
        if (stopped) return;
        setTrackingFailure(reason);
        if (reason === "failed" && attempt === 0) {
          retryTimer = window.setTimeout(() => void BackgroundLocationService.stop().then(() => begin(1)), TRACKING_RETRY_MS);
        }
      };
      const failure = await BackgroundLocationService.start(
        t("backgroundTrackingTitle"),
        t("backgroundTrackingMessage"),
        (latitude, longitude, accuracyMeters) => {
          setTrackingFailure(null);
          recordSample(latitude, longitude, accuracyMeters);
        },
        fail,
      );
      if (failure) fail(failure);
    };
    void begin(0);

    return () => {
      stopped = true;
      window.clearTimeout(retryTimer);
      BackgroundLocationService.stop();
    };
  }, [activePresenceSessionId, backgroundConsent, t, trackingAttempt]);

  // Web fallback path - foreground-tab-only JS interval, unchanged
  // from before. Skipped entirely on native, where the background
  // watcher above already covers both foreground and background.
  // Without background permission (web, or the disclosure declined on
  // Android) samples are taken only while the app is open.
  useEffect(() => {
    if (BackgroundLocationService.isSupported() && backgroundConsent !== "declined") return undefined;
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
  }, [activePresenceSessionId, backgroundConsent]);

  if (trackingFailure && !disclosureOpen) {
    return (
      <Modal isOpen onClose={() => setTrackingFailure(null)} title={t("trackingError.title")}>
        <p style={{ margin: "0 0 var(--space-4)", fontSize: "var(--font-sm)", lineHeight: 1.7, color: "var(--text-primary)" }}>{t(`trackingError.${trackingFailure}`)}</p>
        <div style={{ display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: "var(--space-2)" }}>
          <Button variant="ghost" onClick={() => setTrackingFailure(null)}>
            {t("trackingError.later")}
          </Button>
          {trackingFailure === "permission" ? (
            <Button variant="ghost" onClick={() => void BackgroundLocationService.openSettings()}>
              {t("trackingError.openSettings")}
            </Button>
          ) : null}
          <Button
            onClick={() => {
              setTrackingFailure(null);
              setTrackingAttempt((value) => value + 1);
            }}
          >
            {t("trackingError.retry")}
          </Button>
        </div>
      </Modal>
    );
  }

  if (!disclosureOpen) return null;
  return (
    <Modal isOpen onClose={() => answerDisclosure("declined")} title={t("backgroundDisclosure.title")}>
      <p style={{ margin: "0 0 var(--space-4)", fontSize: "var(--font-sm)", lineHeight: 1.7, color: "var(--text-primary)" }}>{t("backgroundDisclosure.body")}</p>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)" }}>
        <Button variant="ghost" onClick={() => answerDisclosure("declined")}>
          {t("backgroundDisclosure.decline")}
        </Button>
        <Button onClick={() => answerDisclosure("accepted")}>{t("backgroundDisclosure.accept")}</Button>
      </div>
    </Modal>
  );
}
