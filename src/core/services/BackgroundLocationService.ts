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
class BackgroundLocationService {
  private watcherId: string | null = null;

  isSupported(): boolean {
    return Capacitor.isNativePlatform();
  }

  async start(
    backgroundTitle: string,
    backgroundMessage: string,
    onSample: (latitude: number, longitude: number, accuracyMeters: number | null) => void,
  ): Promise<void> {
    if (!this.isSupported() || this.watcherId) return;
    try {
      this.watcherId = await BackgroundGeolocation.addWatcher(
        { backgroundTitle, backgroundMessage, requestPermissions: true, stale: false, distanceFilter: 50 },
        (location?: BackgroundLocation, error?: Error) => {
          if (error || !location) return;
          onSample(location.latitude, location.longitude, location.accuracy ?? null);
        },
      );
    } catch {
      // Best-effort only, same posture as every other geolocation
      // capture in this app - permission denied or plugin failure
      // never breaks anything else.
      this.watcherId = null;
    }
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
