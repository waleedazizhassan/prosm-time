// PROSM Time - update awareness (Finalization & Release Pipeline phase,
// user-directed).
//
// This module only DETECTS and PRESENTS a newer release. It never installs
// anything silently, never executes remote code, and never carries an
// instruction channel: the manifest it reads can only say "a newer version
// exists, here is its official download page". Running an older client can
// not bypass anything either - every protected operation is still decided by
// the server (see supabase/functions/_shared/licenseGate.ts).

export type UpdatePlatform = "web" | "android" | "windows";

export interface ReleaseManifest {
  version: string;
  releasedAt: string | null;
  notes: string | null;
  security: boolean;
  downloads: Partial<Record<UpdatePlatform, string>>;
}

export interface UpdateAvailability {
  currentVersion: string;
  newVersion: string;
  notes: string | null;
  security: boolean;
  platform: UpdatePlatform;
  /** Official download page; null on web, where the app reloads itself. */
  downloadUrl: string | null;
}

const SNOOZE_KEY = "prosm_time_update_snooze";
const NORMAL_SNOOZE_MS = 24 * 60 * 60 * 1000;
const SECURITY_SNOOZE_MS = 60 * 60 * 1000;

export const DEFAULT_MANIFEST_URL = "https://prosm.net/prosm-time/release-manifest.json";

export function manifestUrl(): string {
  const configured = import.meta.env?.VITE_PROSM_TIME_UPDATE_MANIFEST_URL as string | undefined;
  return configured && configured.length > 0 ? configured : DEFAULT_MANIFEST_URL;
}

export function detectPlatform(): UpdatePlatform {
  if (typeof navigator !== "undefined" && /Electron/i.test(navigator.userAgent)) return "windows";
  if (typeof window !== "undefined" && (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.()) {
    return "android";
  }
  return "web";
}

/** Numeric, dot-separated comparison. Returns >0 when `a` is newer than `b`. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) =>
    String(value)
      .trim()
      .replace(/^v/i, "")
      .split(/[.\-+]/)
      .map((part) => Number.parseInt(part, 10))
      .filter((part) => Number.isFinite(part));

  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** Strict, defensive parsing: anything unexpected yields null, never a guess. */
export function parseManifest(payload: unknown): ReleaseManifest | null {
  const raw = (payload ?? {}) as Record<string, unknown>;
  const version = typeof raw.version === "string" ? raw.version.trim() : "";
  if (!/^v?\d+(\.\d+){0,3}$/.test(version)) return null;

  const downloads: Partial<Record<UpdatePlatform, string>> = {};
  const rawDownloads = (raw.downloads ?? {}) as Record<string, unknown>;
  for (const platform of ["web", "android", "windows"] as UpdatePlatform[]) {
    const url = rawDownloads[platform];
    // Only absolute https download pages are ever offered to the user.
    if (typeof url === "string" && url.startsWith("https://")) downloads[platform] = url;
  }

  return {
    version: version.replace(/^v/i, ""),
    releasedAt: typeof raw.releasedAt === "string" ? raw.releasedAt : null,
    notes: typeof raw.notes === "string" ? raw.notes.slice(0, 500) : null,
    security: raw.security === true,
    downloads,
  };
}

export function evaluateUpdate(
  manifest: ReleaseManifest | null,
  currentVersion: string,
  platform: UpdatePlatform,
): UpdateAvailability | null {
  if (!manifest) return null;
  if (compareVersions(manifest.version, currentVersion) <= 0) return null;

  return {
    currentVersion,
    newVersion: manifest.version,
    notes: manifest.notes,
    security: manifest.security,
    platform,
    downloadUrl: platform === "web" ? null : manifest.downloads[platform] ?? null,
  };
}

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** "Later" is remembered per version, so the notice is not nagging. */
export function snoozeUpdate(version: string, security: boolean, now = Date.now()): void {
  const store = storage();
  if (!store) return;
  const until = now + (security ? SECURITY_SNOOZE_MS : NORMAL_SNOOZE_MS);
  try {
    store.setItem(SNOOZE_KEY, JSON.stringify({ version, until }));
  } catch {
    // Not remembering a dismissal only means the notice shows again.
  }
}

export function isSnoozed(version: string, now = Date.now()): boolean {
  const store = storage();
  if (!store) return false;
  try {
    const raw = store.getItem(SNOOZE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { version?: string; until?: number };
    return parsed?.version === version && typeof parsed.until === "number" && parsed.until > now;
  } catch {
    return false;
  }
}

export async function fetchManifest(url = manifestUrl()): Promise<ReleaseManifest | null> {
  try {
    // cache: no-store, so a cached manifest can never hide a new release.
    const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`, {
      cache: "no-store",
      credentials: "omit",
    });
    if (!response.ok) return null;
    return parseManifest(await response.json());
  } catch {
    return null;
  }
}

/**
 * Web "Update now": drop every cached asset and reload, so the browser can
 * not keep serving a half-old, incompatible asset set. Sessions live in
 * storage, not in the cache, so signing in again is not required.
 */
export async function applyWebUpdate(): Promise<void> {
  try {
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
    if (typeof navigator !== "undefined" && navigator.serviceWorker) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }
  } catch {
    // Even if cache clearing fails, the reload below still fetches the
    // freshly hashed entry point.
  }
  window.location.reload();
}
