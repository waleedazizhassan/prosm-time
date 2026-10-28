import { Capacitor } from "@capacitor/core";

// Owner 2026-10-28: on the phone, every permission the app uses is asked for
// once, together, at the start - each with what it is for - instead of one
// at a time later (location at the first clock-in, notifications at sign-in,
// the camera at the first photo). The answer is remembered on the device.
// The screen that asks is also the prominent disclosure Google Play requires
// before location is used during a shift, so accepting it counts as the
// shift-location consent too.
export type StartupPermissionsAnswer = "unknown" | "accepted" | "declined";

const STARTUP_PERMISSIONS_KEY = "prosm_time_startup_permissions_v1";
const BACKGROUND_CONSENT_KEY = "prosm_time_background_location_disclosure_v1";
export const STARTUP_PERMISSIONS_EVENT = "prosm-time:startup-permissions";

export type BackgroundConsent = "unknown" | "accepted" | "declined";

function read(key: string): "unknown" | "accepted" | "declined" {
  try {
    const value = localStorage.getItem(key);
    return value === "accepted" || value === "declined" ? value : "unknown";
  } catch {
    return "unknown";
  }
}

function write(key: string, value: "accepted" | "declined") {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable - asked again next time
  }
}

export const readBackgroundConsent = (): BackgroundConsent => read(BACKGROUND_CONSENT_KEY);
export const writeBackgroundConsent = (value: "accepted" | "declined") => write(BACKGROUND_CONSENT_KEY, value);

/** Only the phone app asks at the start; the web asks when a feature is used, as before. */
export const startupPermissionsApply = () => Capacitor.isNativePlatform();

export function readStartupPermissions(): StartupPermissionsAnswer {
  return startupPermissionsApply() ? read(STARTUP_PERMISSIONS_KEY) : "accepted";
}

const askLocation = () =>
  new Promise<void>((resolve) => {
    if (!navigator.geolocation) return resolve();
    navigator.geolocation.getCurrentPosition(() => resolve(), () => resolve(), { enableHighAccuracy: false, timeout: 20_000, maximumAge: 600_000 });
  });

// The camera is opened for a moment only so Android asks; nothing is captured.
async function askCamera() {
  try {
    const stream = await navigator.mediaDevices?.getUserMedia({ video: true });
    stream?.getTracks().forEach((track) => track.stop());
  } catch {
    // refused, or no camera: a site that needs a photo asks again then
  }
}

async function askNotifications() {
  try {
    const { LocalNotifications } = await import("@capacitor/local-notifications");
    const permission = await LocalNotifications.checkPermissions();
    if (permission.display !== "granted") await LocalNotifications.requestPermissions();
  } catch {
    // plugin unavailable
  }
}

/** The answer on the start screen: on "accepted", Android's own dialogs follow, one after another. */
export async function answerStartupPermissions(answer: "accepted" | "declined"): Promise<void> {
  write(STARTUP_PERMISSIONS_KEY, answer);
  if (answer === "accepted") {
    writeBackgroundConsent("accepted");
    await askLocation();
    await askCamera();
    await askNotifications();
  }
  window.dispatchEvent(new Event(STARTUP_PERMISSIONS_EVENT));
}
