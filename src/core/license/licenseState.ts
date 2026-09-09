// PROSM Time - how a server license decision is presented in the UI
// (License Enforcement & Installation Identity phase, user-directed).
//
// Pure mapping only. Nothing here grants or denies anything: the server has
// already decided, and this file just chooses which message the user sees.

export type LicenseState =
  | "LICENSED"
  | "GRACE"
  | "UNLICENSED"
  | "EXPIRED"
  | "SUSPENDED"
  | "BLOCKED"
  | "REVOKED"
  | "UNKNOWN";

export interface LicenseSnapshot {
  state: LicenseState;
  identified: boolean;
  allowed: boolean;
  graceEndsAt: string | null;
  graceDaysRemaining: number | null;
  licenseStatus: string | null;
  licenseExpiresAt: string | null;
  protectionVersion: number | null;
  /** True when the last check could not reach the server. */
  stale: boolean;
}

export const UNKNOWN_LICENSE: LicenseSnapshot = {
  state: "UNKNOWN",
  identified: false,
  allowed: true,
  graceEndsAt: null,
  graceDaysRemaining: null,
  licenseStatus: null,
  licenseExpiresAt: null,
  protectionVersion: null,
  stale: true,
};

const KNOWN_STATES: LicenseState[] = [
  "LICENSED",
  "GRACE",
  "UNLICENSED",
  "EXPIRED",
  "SUSPENDED",
  "BLOCKED",
  "REVOKED",
];

export function toLicenseSnapshot(payload: unknown): LicenseSnapshot {
  const raw = (payload ?? {}) as Record<string, unknown>;
  const state = KNOWN_STATES.includes(raw.state as LicenseState) ? (raw.state as LicenseState) : "UNKNOWN";
  const days = typeof raw.graceDaysRemaining === "number" ? Math.max(0, Math.floor(raw.graceDaysRemaining)) : null;

  return {
    state,
    identified: Boolean(raw.identified),
    allowed: raw.allowed === undefined ? state === "LICENSED" || state === "GRACE" : Boolean(raw.allowed),
    graceEndsAt: typeof raw.graceEndsAt === "string" ? raw.graceEndsAt : null,
    graceDaysRemaining: days,
    licenseStatus: typeof raw.licenseStatus === "string" ? raw.licenseStatus : null,
    licenseExpiresAt: typeof raw.licenseExpiresAt === "string" ? raw.licenseExpiresAt : null,
    protectionVersion: typeof raw.protectionVersion === "number" ? raw.protectionVersion : null,
    stale: false,
  };
}

export type LicenseNoticeTone = "warning" | "critical";

export interface LicenseNotice {
  tone: LicenseNoticeTone;
  /** i18n key inside the `license` namespace. */
  messageKey: string;
  /** i18n key of the action, or null when there is no self-service action. */
  actionKey: string | null;
  daysRemaining: number | null;
}

/**
 * Returns the persistent banner to show, or null when the installation is
 * properly licensed (or the state simply isn't known yet - a check that
 * couldn't reach the server never accuses the customer of piracy).
 */
export function licenseNotice(snapshot: LicenseSnapshot): LicenseNotice | null {
  switch (snapshot.state) {
    case "GRACE":
    case "UNLICENSED":
      return {
        tone: "warning",
        messageKey: "notice.grace",
        actionKey: "action.activate",
        daysRemaining: snapshot.graceDaysRemaining,
      };
    case "EXPIRED":
      return { tone: "critical", messageKey: "notice.expired", actionKey: "action.activate", daysRemaining: null };
    case "SUSPENDED":
      return { tone: "critical", messageKey: "notice.suspended", actionKey: "action.support", daysRemaining: null };
    case "BLOCKED":
      return { tone: "critical", messageKey: "notice.blocked", actionKey: "action.support", daysRemaining: null };
    case "REVOKED":
      return { tone: "critical", messageKey: "notice.revoked", actionKey: "action.support", daysRemaining: null };
    default:
      return null;
  }
}
