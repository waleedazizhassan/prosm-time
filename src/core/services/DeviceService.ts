import { Capacitor } from "@capacitor/core";

import { requireSupabaseClient } from "../api/supabaseClient";

// v2.3.55 (owner 2026-10-27: "the licence's devices are the devices that
// actually have an account open on them"): this phone or browser has its own
// id, kept on the device. It is registered when someone signs in here and
// whenever the app opens (the server counts a device while it was seen in
// the last 30 days), and forgotten when they sign out. A new device is
// refused when the licence's devices are all in use.
const DEVICE_KEY = "prosm_time_device_id";
export const DEVICE_LIMIT_MESSAGE = "LICENSED DEVICE LIMIT REACHED";
const BLOCKED_KEY = "prosm_time_device_limit_blocked";

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `dev-${crypto.randomUUID()}`;
  return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

export function deviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing && existing.length >= 16) return existing;
    const created = newId();
    localStorage.setItem(DEVICE_KEY, created);
    return created;
  } catch {
    // storage unavailable: an id for this visit
    return newId();
  }
}

function label(): string {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const android = /Android [\d.]+;\s*([^;)]+)/.exec(agent);
  if (android) return `Android - ${android[1].replace(/Build.*$/, "").trim()}`;
  if (/iPhone|iPad/.test(agent)) return "iOS";
  if (/Windows/.test(agent)) return "Windows";
  if (/Mac OS/.test(agent)) return "Mac";
  return "Browser";
}

/** Registers this device for the signed-in person. Resolves to "limit" when the licence's devices are all in use. */
export async function registerDevice(): Promise<"ok" | "limit" | "error"> {
  try {
    const platform = Capacitor.getPlatform();
    const { error } = await requireSupabaseClient().rpc("register_prosm_time_device", {
      p_device_id: deviceId(),
      p_platform: platform === "android" || platform === "ios" ? platform : "web",
      p_label: label(),
    });
    if (!error) return "ok";
    return error.message.includes(DEVICE_LIMIT_MESSAGE) ? "limit" : "error";
  } catch {
    return "error";
  }
}

/** Before signing out: this device no longer counts. */
export async function forgetDevice(): Promise<void> {
  try {
    await requireSupabaseClient().rpc("forget_prosm_time_device", { p_device_id: deviceId() });
  } catch {
    // offline: it stops counting after 30 days unseen
  }
}

// the sign-in page explains why it was signed out
export function markDeviceLimitBlocked(): void {
  try {
    sessionStorage.setItem(BLOCKED_KEY, "1");
  } catch {
    // storage unavailable
  }
}

export function takeDeviceLimitBlocked(): boolean {
  try {
    const blocked = sessionStorage.getItem(BLOCKED_KEY) === "1";
    sessionStorage.removeItem(BLOCKED_KEY);
    return blocked;
  } catch {
    return false;
  }
}
