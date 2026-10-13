// A page part from an older build could not be loaded. After a new web
// build is published, an open tab still asks for the previous build's
// files; prosm.net answers a missing file with the app's HTML page (200,
// text/html), so the browser reports a MIME-type error rather than a
// network one (owner 2026-10-13: the Sites page showed the error screen
// right after v2.3.19 went live).
const STALE_BUILD_PATTERN =
  /dynamically imported module|importing a module script failed|error loading dynamically|ChunkLoadError|Loading chunk|disallowed MIME type|Expected a JavaScript(-or-Wasm)? module script|Unable to preload CSS|Failed to load module script/i;

const RELOAD_KEY = "prosm_time_page_reload_at";

export function isStaleBuildError(error: unknown): boolean {
  return STALE_BUILD_PATTERN.test(String((error as Error)?.message ?? error));
}

/** Reloads once to pick up the new build; never more than once in 30 seconds, never offline. Returns whether it reloaded. */
export function reloadForNewBuild(): boolean {
  if (typeof navigator !== "undefined" && !navigator.onLine) return false;
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
  } catch {
    // storage unavailable
  }
  if (Date.now() - last <= 30000) return false;
  try {
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // storage unavailable
  }
  window.location.reload();
  return true;
}
