import { registerPlugin, Capacitor } from "@capacitor/core";
import type { BackgroundGeolocationPlugin, Location as BackgroundLocation } from "@capacitor-community/background-geolocation";

const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>("BackgroundGeolocation");

// PROSM Time - § user-directed, 2026-09-13: real geofence-exit
// tracking must survive the app being backgrounded (screen locked,
// another app in front), not just stop the moment the screen turns
// off. @capacitor-community/background-geolocation is the only piece
// of this that genuinely needs native code - a JS setInterval (what
// PresenceTrackingLoop already does for web/foreground) is throttled
// or fully suspended by the OS the moment the app isn't visible.
//
// Android requires a persistent, user-visible, always-cancellable
// notification to keep a background location watch alive (both a
// Google Play policy requirement and how this plugin is actually
// built) - addWatcher's own backgroundMessage/backgroundTitle options
// below are what produce that notification, never silent background
// tracking. requestPermissions: true triggers the real OS consent
// dialogs (foreground location first, then Android's own separate
// "Allow all the time" background step) - a user who declines simply
// never gets background samples; this never blocks Clock In/Out or
// any other flow, matching this app's existing "location capture is
// always best-effort" posture everywhere else.
export type TrackingFailure = "permission" | "failed";

// The plugin reports a refused permission as NOT_AUTHORIZED.
export function trackingFailureOf(error: unknown): TrackingFailure {
  const code = (error as { code?: string } | null)?.code ?? "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  return code === "NOT_AUTHORIZED" || /permission|authori[sz]ed/i.test(message) ? "permission" : "failed";
}

class BackgroundLocationService {
  private watcherId: string | null = null;

  isSupported(): boolean {
    return Capacitor.isNativePlatform();
  }

  // v2.3.43 step 19 (item 13): a failure is no longer swallowed - it is
  // logged and reported (no location permission, or the service could not
  // start) so the person is told and can try again. Clock in/out is never
  // blocked by it.
  async start(
    backgroundTitle: string,
    backgroundMessage: string,
    onSample: (latitude: number, longitude: number, accuracyMeters: number | null) => void,
    onFailure?: (reason: TrackingFailure) => void,
  ): Promise<TrackingFailure | null> {
    if (!this.isSupported() || this.watcherId) return null;
    try {
      this.watcherId = await BackgroundGeolocation.addWatcher(
        { backgroundTitle, backgroundMessage, requestPermissions: true, stale: false, distanceFilter: 50 },
        (location?: BackgroundLocation, error?: Error & { code?: string }) => {
          if (error) {
            console.warn("[tracking] the location watcher reported an error", error);
            onFailure?.(trackingFailureOf(error));
            return;
          }
          if (!location) return;
          onSample(location.latitude, location.longitude, location.accuracy ?? null);
        },
      );
      return null;
    } catch (error) {
      console.warn("[tracking] could not start background location", error);
      this.watcherId = null;
      return trackingFailureOf(error);
    }
  }

  async openSettings(): Promise<void> {
    try {
      await BackgroundGeolocation.openSettings();
    } catch (error) {
      console.warn("[tracking] could not open the app settings", error);
    }
  }

  // Audit 2.4 (2026-10-13) - whether the device reports the current
  // location as simulated (Android mock location; the plugin's own
  // isFromMockProvider flag). One foreground reading, then the watcher is
  // removed. null when unknown: not native, no permission, or no reading
  // within the time limit - never blocks Clock In/Out.
  async detectSimulated(timeoutMs = 5000): Promise<boolean | null> {
    if (!this.isSupported()) return null;
    return new Promise((resolve) => {
      let watcherId: string | null = null;
      let settled = false;
      const finish = (value: boolean | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (watcherId) BackgroundGeolocation.removeWatcher({ id: watcherId }).catch(() => undefined);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      BackgroundGeolocation.addWatcher({ requestPermissions: false, stale: false }, (location?: BackgroundLocation, error?: Error) => {
        if (error || !location) {
          finish(null);
          return;
        }
        finish(Boolean(location.simulated));
      })
        .then((id) => {
          watcherId = id;
          if (settled) BackgroundGeolocation.removeWatcher({ id }).catch(() => undefined);
        })
        .catch(() => finish(null));
    });
  }

  async stop(): Promise<void> {
    if (!this.watcherId) return;
    const id = this.watcherId;
    this.watcherId = null;
    try {
      await BackgroundGeolocation.removeWatcher({ id });
    } catch {
      // Nothing meaningful to recover here - the watcher reference is
      // already cleared either way.
    }
  }
}

export default new BackgroundLocationService();
