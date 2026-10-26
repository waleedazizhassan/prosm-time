// v2.3.43 step 21 (owner 2026-10-26: "the 2D pictures that show with error
// messages and lost connection - use the idea across the whole app, the
// picture fitting each case"). Which kind of situation a message is about,
// so the shared message components can show a fitting illustration.
// The kind is decided from the server's own raw message (always English
// codes) when humanizeBackendError translates it, and remembered for the
// translated text - no page has to pass it, though a page may.
export type StateKind =
  | "error"
  | "offline"
  | "permission"
  | "location"
  | "camera"
  | "notFound"
  | "session"
  | "empty"
  | "success"
  | "waiting"
  | "sync"
  | "upload"
  | "server";

const NETWORK = /failed to fetch|networkerror|network request failed|load failed|fetch failed|failed to send a request|err_internet_disconnected|timed? ?out/i;

export function classifyBackendError(raw: string): StateKind {
  if (NETWORK.test(raw)) return "offline";
  if (/NO AUTHENTICATED SESSION|INVALID OR EXPIRED SESSION|JWT|SESSION EXPIRED|REFRESH TOKEN/i.test(raw)) return "session";
  if (/AUTHORITY REQUIRED|NOT AUTHORI[SZ]ED|YOU DO NOT MANAGE|ONLY THE OWNER|INSUFFICIENT AUTHORITY|PERMISSION DENIED|NOT ALLOWED/i.test(raw)) return "permission";
  if (/PHOTO|CAMERA|CAPTURE|EVIDENCE|LIVENESS/i.test(raw)) return "camera";
  if (/OUTSIDE|GEOFENCE|LOCATION|DISTANCE|WORK AREA|GPS|COORDINATE|SIMULATED/i.test(raw)) return "location";
  if (/UPLOAD|FILE TOO|DOCUMENT/i.test(raw)) return "upload";
  if (/NOT FOUND/i.test(raw)) return "notFound";
  return "error";
}

// translated text -> kind (bounded; the newest win)
const remembered = new Map<string, StateKind>();
const LIMIT = 300;

export function rememberErrorKind(text: string, kind: StateKind): void {
  remembered.delete(text);
  remembered.set(text, kind);
  if (remembered.size > LIMIT) remembered.delete(remembered.keys().next().value as string);
}

export function errorKindFor(text: string): StateKind | null {
  return remembered.get(text) ?? null;
}
