// PROSM Time - §13 "Map-based configuration and a test/verify
// function." This is a preview/setup utility for the site-configuration
// form only - pure client-side geometry to help an admin place a site's
// center and sanity-check the radius they typed. It is never the
// source of truth for an actual Clock In geofence decision: §15 is
// explicit that "geofence calculation is performed server-side...
// never rely only on client-side distance checks" - that real
// enforcement is WP-09's job, against a captured attendance event, not
// this draft-form helper.

const EARTH_RADIUS_METERS = 6371000;

export function haversineDistanceMeters(latitude1: number, longitude1: number, latitude2: number, longitude2: number): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

  const deltaLatitude = toRadians(latitude2 - latitude1);
  const deltaLongitude = toRadians(longitude2 - longitude1);

  const a =
    Math.sin(deltaLatitude / 2) ** 2 + Math.cos(toRadians(latitude1)) * Math.cos(toRadians(latitude2)) * Math.sin(deltaLongitude / 2) ** 2;

  return EARTH_RADIUS_METERS * 2 * Math.asin(Math.sqrt(a));
}

export interface CurrentPosition {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
}

// § user-reported real perf issue (#11, 2026-09-15): "Weather... very
// slow to load." Root cause: every caller of this function - including
// WeatherMiniPanel, which only needs city-level precision - paid the
// same enableHighAccuracy:true, 10s-timeout GPS request every real
// geofence caller (Clock In/Out, Kiosk, admin-on-behalf) genuinely
// needs for real geofence precision. High-accuracy mode tries the
// actual GPS receiver, which can take many seconds (or fail entirely
// indoors/cold-start) - the wrong tradeoff for a weather widget.
// Options are additive and optional so every existing real geofence
// caller is byte-for-byte unaffected (same defaults as before);
// WeatherMiniPanel is the only caller that opts into the fast path.
// Owner 2026-11-04 ("the sites, the accuracy and the work areas"): a phone's first reading is
// often a coarse network fix (300-400 m seen in real clock-ins). An attendance reading keeps
// listening for a few seconds and takes the best one, stopping as soon as it is good enough.
const GOOD_ENOUGH_METERS = 25;
const REFINE_MS = 8000;

export function getCurrentPosition(options?: { highAccuracy?: boolean; timeoutMs?: number }): Promise<CurrentPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation is not available in this browser."));
      return;
    }
    const highAccuracy = options?.highAccuracy ?? true;
    const toPosition = (position: GeolocationPosition): CurrentPosition => ({
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracyMeters: position.coords.accuracy,
    });

    if (!highAccuracy || typeof navigator.geolocation.watchPosition !== "function") {
      navigator.geolocation.getCurrentPosition(
        (position) => resolve(toPosition(position)),
        (error) => reject(new Error(error.message || "Unable to determine your location.")),
        { enableHighAccuracy: highAccuracy, timeout: options?.timeoutMs ?? 10000 },
      );
      return;
    }

    let best: CurrentPosition | null = null;
    let done = false;
    let watchId: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      if (timer) clearTimeout(timer);
      if (best) resolve(best);
      else reject(error ?? new Error("Unable to determine your location."));
    };
    // the best reading within the refine window; with none yet, wait to the full timeout
    const refineMs = Math.min(REFINE_MS, options?.timeoutMs ?? 10000);
    const hardTimeout = Math.max(options?.timeoutMs ?? 10000, refineMs);
    const started = Date.now();
    watchId = navigator.geolocation.watchPosition(
      (position) => {
        const reading = toPosition(position);
        if (!best || reading.accuracyMeters < best.accuracyMeters) best = reading;
        if (reading.accuracyMeters <= GOOD_ENOUGH_METERS || Date.now() - started >= refineMs) finish();
      },
      (error) => {
        if (!best) finish(new Error(error.message || "Unable to determine your location."));
      },
      { enableHighAccuracy: true, timeout: hardTimeout, maximumAge: 0 },
    );
    timer = setTimeout(() => finish(), best ? refineMs : hardTimeout);
    // after the refine window, a reading already in hand is used at once
    setTimeout(() => {
      if (best) finish();
    }, refineMs);
  });
}
