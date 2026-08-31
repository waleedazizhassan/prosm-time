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

export function getCurrentPosition(): Promise<CurrentPosition> {
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
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}
