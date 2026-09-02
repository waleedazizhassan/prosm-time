// PROSM Time - live UX review, user-directed: the Confirm-Clock-In
// summary should show a device line ("via Android 16" in the reference
// screenshot). A plain client-side navigator.userAgent read - display
// only, never sent anywhere new, never used for any device-trust
// decision (DeviceBindingRepository/device_bindings remains the real
// governance mechanism for that).
export function getDeviceLabel(): string {
  const ua = navigator.userAgent;

  const androidMatch = ua.match(/Android\s([\d.]+)/);
  if (androidMatch) return `Android ${androidMatch[1]}`;

  const iosMatch = ua.match(/OS\s([\d_]+)\slike Mac OS X/);
  if (iosMatch) return `iOS ${iosMatch[1].replace(/_/g, ".")}`;

  const macMatch = ua.match(/Mac OS X\s([\d_]+)/);
  if (macMatch && !ua.includes("Mobile")) return `macOS ${macMatch[1].replace(/_/g, ".")}`;

  if (ua.includes("Windows NT")) return "Windows";

  if (/Linux/.test(ua) && !/Android/.test(ua)) return "Linux";

  return navigator.platform || "Unknown device";
}
