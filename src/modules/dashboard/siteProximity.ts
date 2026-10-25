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
