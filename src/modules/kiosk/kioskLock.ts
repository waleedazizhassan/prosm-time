// Audit 1.3 (2026-10-13) - which site's kiosk this device is locked to.
// Kept in localStorage so a reload, a new tab or the Android back button
// can't drop the shared tablet back into the signed-in person's app;
// only the exit check in KioskLayout clears it.
const STORAGE_KEY = "prosm_time_kiosk_lock_v1";

export function getLockedKioskSite(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function lockKiosk(siteId: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, siteId);
  } catch {
    // storage blocked: the route guard still holds while this page is open
  }
}

export function unlockKiosk(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // nothing stored
  }
}

export function kioskPath(siteId: string): string {
  return `/kiosk/${siteId}`;
}
