// PROSM Time - the client half of Installation Identity (License
// Enforcement & Installation Identity phase, user-directed).
//
// This module only CARRIES the identity: it asks the server for a key/secret
// pair once, keeps it, and attaches it to outgoing calls. It decides nothing.
// Deleting or forging what is stored here does not grant anything - the
// server re-derives the organization from the caller's own session and
// treats an unknown installation as unlicensed, which starts the grace
// window rather than unlocking the product.

import { APP_VERSION } from "../appVersion";

const STORAGE_KEY = "prosm_time_installation_identity";

export interface InstallationIdentity {
  installationKey: string;
  installationSecret: string;
}

export const INSTALLATION_KEY_HEADER = "x-prosm-installation-key";
export const INSTALLATION_SECRET_HEADER = "x-prosm-installation-secret";

function safeStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readInstallationIdentity(): InstallationIdentity | null {
  const storage = safeStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<InstallationIdentity>;
    if (typeof parsed?.installationKey !== "string" || typeof parsed?.installationSecret !== "string") {
      return null;
    }
    return { installationKey: parsed.installationKey, installationSecret: parsed.installationSecret };
  } catch {
    return null;
  }
}

export function writeInstallationIdentity(identity: InstallationIdentity): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(identity));
  } catch {
    // A storage failure only means this installation stays unidentified and
    // is treated as unlicensed by the server. It never grants access.
  }
}

/** Headers for any request that should carry the installation identity. */
export function installationHeaders(): Record<string, string> {
  const identity = readInstallationIdentity();
  if (!identity) return {};
  return {
    [INSTALLATION_KEY_HEADER]: identity.installationKey,
    [INSTALLATION_SECRET_HEADER]: identity.installationSecret,
  };
}

function functionsBaseUrl(): string {
  const url = import.meta.env.VITE_SUPABASE_URL;
  if (!url) throw new Error("Missing Supabase environment variables.");
  return `${String(url).replace(/\/$/, "")}/functions/v1`;
}

function platform(): string {
  if (typeof navigator === "undefined") return "unknown";
  const agent = navigator.userAgent ?? "";
  if (/Android/i.test(agent)) return "android";
  if (/Electron/i.test(agent)) return "windows";
  return "web";
}

/**
 * Registers this installation once and returns the stored identity. Called at
 * startup; a failure is not fatal - the app keeps working and the server sees
 * an unidentified installation on its next call.
 */
export async function ensureInstallationIdentity(accessToken?: string | null): Promise<InstallationIdentity | null> {
  const existing = readInstallationIdentity();
  if (existing) return existing;

  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!anonKey) return null;

  try {
    const response = await fetch(`${functionsBaseUrl()}/register-installation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anonKey,
        Authorization: `Bearer ${accessToken ?? anonKey}`,
      },
      body: JSON.stringify({ platform: platform(), appVersion: APP_VERSION, deviceLabel: null }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.success) return null;

    const identity: InstallationIdentity = {
      installationKey: body.data.installationKey,
      installationSecret: body.data.installationSecret,
    };
    writeInstallationIdentity(identity);
    return identity;
  } catch {
    return null;
  }
}
