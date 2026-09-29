import { getValue, setValue, KEYS_STORE } from "./db";

// Offline queue at rest (owner 2026-09-29): each queued attendance action - its location, note,
// site and photo - is stored encrypted with AES-GCM under a per-device key generated here and kept
// as a non-extractable CryptoKey (the app can use it, never read or export it). Where the Web Crypto
// API is not available, the action is still kept (unencrypted) rather than lost.

const KEY_NAME = "queue-aes-gcm-v1";
let keyPromise: Promise<CryptoKey | null> | null = null;

export const cryptoAvailable = () => typeof crypto !== "undefined" && !!crypto.subtle && typeof indexedDB !== "undefined";

async function loadKey(): Promise<CryptoKey | null> {
  if (!cryptoAvailable()) return null;
  const existing = await getValue<CryptoKey>(KEYS_STORE, KEY_NAME);
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await setValue(KEYS_STORE, KEY_NAME, key);
  return key;
}

function queueKey(): Promise<CryptoKey | null> {
  if (!keyPromise) keyPromise = loadKey().catch(() => null);
  return keyPromise;
}

export interface Sealed {
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
}

export async function seal(bytes: ArrayBuffer): Promise<Sealed | null> {
  const key = await queueKey();
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { iv, data: await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes) };
}

export async function open(sealed: Sealed): Promise<ArrayBuffer> {
  const key = await queueKey();
  if (!key) throw new Error("The offline queue key is not available on this device.");
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv }, key, sealed.data);
}

export const encodeJson = (value: unknown): ArrayBuffer => new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;
export const decodeJson = <T,>(bytes: ArrayBuffer): T => JSON.parse(new TextDecoder().decode(bytes)) as T;
