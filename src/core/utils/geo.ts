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
export function getCurrentPosition(options?: { highAccuracy?: boolean; timeoutMs?: number }): Promise<CurrentPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation is not available in this browser."));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: position.coords.accuracy,
        });
      },
      (error) => {
        reject(new Error(error.message || "Unable to determine your location."));
      },
      { enableHighAccuracy: options?.highAccuracy ?? true, timeout: options?.timeoutMs ?? 10000 }
    );
  });
}
