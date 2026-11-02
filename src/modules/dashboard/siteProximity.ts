import { haversineDistanceMeters } from "../../core/utils/geo";

export interface ProximitySite {
  id: string;
  latitude: number;
  longitude: number;
  allowedRadiusMeters: number;
  gpsAccuracyToleranceMeters?: number;
}

export interface SiteProximity {
  siteId: string;
  inside: boolean;
  distanceMeters: number;
  // How far outside the work area (0 when inside).
  outsideByMeters: number;
}

// v2.3.43 step 13 (item 15): the site the employee is inside (the closest
// when several overlap), or else the nearest site and how far outside its
// area they are. The site's radius plus the reading's own accuracy (capped by
// the site's GPS tolerance) counts as inside, as on the server.
export function nearestSite(sites: ProximitySite[], latitude: number, longitude: number, accuracyMeters: number | null): SiteProximity | null {
  let best: SiteProximity | null = null;
  for (const site of sites) {
    if (!site.allowedRadiusMeters) continue;
    const distance = haversineDistanceMeters(latitude, longitude, site.latitude, site.longitude);
    const slack = Math.min(accuracyMeters ?? 0, site.gpsAccuracyToleranceMeters ?? 50);
    const outsideBy = Math.max(0, distance - site.allowedRadiusMeters - slack);
    const candidate = { siteId: site.id, inside: outsideBy === 0, distanceMeters: distance, outsideByMeters: Math.round(outsideBy) };
    if (!best || (candidate.inside && !best.inside) || (candidate.inside === best.inside && candidate.distanceMeters < best.distanceMeters)) best = candidate;
  }
  return best;
}

// Owner 2026-11-02: the clock-in list by distance: the site the person stands in
// first, then the nearest. A site with no position, or no reading yet, keeps its
// place at the end, in the order it came.
export function orderSitesByDistance<T extends { id: string; latitude: number | null; longitude: number | null; allowedRadiusMeters: number; gpsAccuracyToleranceMeters?: number }>(
  sites: T[],
  position: { latitude: number; longitude: number; accuracyMeters: number | null } | null,
): { site: T; inside: boolean }[] {
  if (!position) return sites.map((site) => ({ site, inside: false }));
  const measured = sites.map((site) => {
    if (site.latitude === null || site.longitude === null) return { site, inside: false, distance: Infinity };
    const distance = haversineDistanceMeters(position.latitude, position.longitude, site.latitude, site.longitude);
    const slack = Math.min(position.accuracyMeters ?? 0, site.gpsAccuracyToleranceMeters ?? 50);
    return { site, inside: site.allowedRadiusMeters > 0 && distance <= site.allowedRadiusMeters + slack, distance };
  });
  return measured.sort((a, b) => Number(b.inside) - Number(a.inside) || a.distance - b.distance).map(({ site, inside }) => ({ site, inside }));
}
