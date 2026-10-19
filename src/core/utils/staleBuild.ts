// A page part could not be loaded. After a new web build is published, an
// open tab still asks for the previous build's files; prosm.net answers a
// missing file with the app's HTML page (200, text/html), so the browser
// reports a MIME-type error rather than a network one (owner 2026-10-13:
// the Sites page showed the error screen right after v2.3.19 went live).
// The same host also sometimes answers a file that does exist with that
// HTML page (owner 2026-10-19, measured at about 1 request in 3), so a
// reload can fail again - it is tried a few times before giving up.
const STALE_BUILD_PATTERN =
  /dynamically imported module|importing a module script failed|error loading dynamically|ChunkLoadError|Loading chunk|disallowed MIME type|Expected a JavaScript(-or-Wasm)? module script|Unable to preload CSS|Failed to load module script/i;

const RELOAD_KEY = "prosm_time_page_reload_at";
export const MAX_RELOADS = 3;
export const RELOAD_WINDOW_MS = 120000;

export function isStaleBuildError(error: unknown): boolean {
  return STALE_BUILD_PATTERN.test(String((error as Error)?.message ?? error));
}

function readReloads(now: number): number[] {
  try {
    const saved = JSON.parse(sessionStorage.getItem(RELOAD_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((at) => typeof at === "number" && now - at < RELOAD_WINDOW_MS) : [];
  } catch {
    return [];
  }
}

/** Reloads to pick up the page's files again: at most MAX_RELOADS times in RELOAD_WINDOW_MS, never offline. Returns whether it reloaded. */
export function reloadForNewBuild(): boolean {
  if (typeof navigator !== "undefined" && !navigator.onLine) return false;
  const now = Date.now();
  const reloads = readReloads(now);
  if (reloads.length >= MAX_RELOADS) return false;
  try {
    sessionStorage.setItem(RELOAD_KEY, JSON.stringify([...reloads, now]));
  } catch {
    // storage unavailable: the reloads could not be counted, so no automatic
    // reload (it could repeat forever) - the message and its button instead
    return false;
  }
  window.location.reload();
  return true;
}

/** The reader pressed "Try again": a fresh round of reloads. */
export function retryPageLoad(): void {
  try {
    sessionStorage.removeItem(RELOAD_KEY);
  } catch {
    // storage unavailable
  }
  window.location.reload();
}
