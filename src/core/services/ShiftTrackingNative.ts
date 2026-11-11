import { Capacitor, registerPlugin } from "@capacitor/core";

import { requireSupabaseClient } from "../api/supabaseClient";

// Owner 2026-11-11 ("people leave the sites and nothing happens until they open the app - make it run in
// the background like WhatsApp, light on battery and data"): the Android app follows the shift with its
// own service (android/.../ShiftTrackingService.java), which keeps working after the app is closed and
// sends each location straight to the server with a tracking key for this shift. This is the app's side.

export interface ShiftTrackingStatus {
  active: boolean;
  location: boolean;
  preciseLocation: boolean;
  notifications: boolean;
  ignoringBattery: boolean;
}

interface ShiftTrackingPlugin {
  start(options: {
    url: string;
    anonKey: string;
    key: string;
    title: string;
    text: string;
    exitTitle: string;
    exitBody: string;
    resumeTitle: string;
    resumeBody: string;
  }): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<ShiftTrackingStatus>;
  openBatterySettings(): Promise<void>;
  openAppSettings(): Promise<void>;
}

const ShiftTracking = registerPlugin<ShiftTrackingPlugin>("ShiftTracking");

/** The Android app with the service (not the web, not an older build). */
export function shiftTrackingAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("ShiftTracking");
}

export async function shiftTrackingStatus(): Promise<ShiftTrackingStatus | null> {
  if (!shiftTrackingAvailable()) return null;
  try {
    return await ShiftTracking.status();
  } catch {
    return null;
  }
}

/** What still keeps the phone from following the shift (empty = ready). */
export function missingForTracking(status: ShiftTrackingStatus | null): ("location" | "notifications" | "battery")[] {
  if (!status) return [];
  const missing: ("location" | "notifications" | "battery")[] = [];
  if (!status.location) missing.push("location");
  if (!status.notifications) missing.push("notifications");
  if (!status.ignoringBattery) missing.push("battery");
  return missing;
}

export async function openBatterySettings(): Promise<void> {
  try {
    await ShiftTracking.openBatterySettings();
  } catch {
    // nothing to open
  }
}

export async function openTrackingAppSettings(): Promise<void> {
  try {
    await ShiftTracking.openAppSettings();
  } catch {
    // nothing to open
  }
}

export interface ShiftTrackingTexts {
  title: string;
  text: string;
  exitTitle: string;
  exitBody: string;
  resumeTitle: string;
  resumeBody: string;
}

/** Starts (or restarts) the service with a fresh tracking key. false when it could not start. */
export async function startShiftTracking(texts: ShiftTrackingTexts): Promise<boolean> {
  if (!shiftTrackingAvailable()) return false;
  try {
    const { data: key, error } = await requireSupabaseClient().rpc("issue_prosm_time_tracking_key");
    if (error || typeof key !== "string") return false;
    await ShiftTracking.start({
      url: import.meta.env.VITE_SUPABASE_URL,
      anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      key,
      ...texts,
    });
    return true;
  } catch (error) {
    console.warn("[tracking] the shift service could not start", error);
    return false;
  }
}

export async function stopShiftTracking(): Promise<void> {
  if (!shiftTrackingAvailable()) return;
  try {
    await ShiftTracking.stop();
  } catch {
    // already stopped
  }
}
