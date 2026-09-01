// WP-24/§36 - "Define adapter interfaces for... site... providers."
// See ./README.md. Shape matches SiteRepository's own real Site type.
//
// Today's real implementation: SiteRepository
// (src/core/repositories/SiteRepository.ts), backed by PROSM Time's
// own `sites` table (coordinates, radius, GPS tolerance, kiosk policy
// - §13). A future PROSM Platform-native integration would resolve
// the same shape from PROSM Platform's own site/location model.

export type SiteKioskMode = "personal_device_only" | "kiosk_only" | "both_allowed";

export interface SiteContext {
  id: string;
  name: string;
  displayAddress: string | null;
  latitude: number;
  longitude: number;
  allowedRadiusMeters: number;
  gpsAccuracyToleranceMeters: number;
  timezone: string;
  isActive: boolean;
  attendanceAllowed: boolean;
  geofenceRequired: boolean;
  cameraRequired: boolean;
  kioskMode: SiteKioskMode;
  graceToleranceMinutes: number;
}

export interface SiteProvider {
  getSite(siteId: string): Promise<SiteContext | null>;
  listAssignedSites(userId: string): Promise<SiteContext[]>;
}
