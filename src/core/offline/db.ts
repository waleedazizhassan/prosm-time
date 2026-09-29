// PROSM Time WP-15/§25/§34 - `offline_sync_queue` is explicitly a
// "client-side" table (the server side of the same contract is the
// idempotency_key unique constraint already enforced on
// attendance_events since WP-06). IndexedDB (not localStorage) is the
// only browser storage that can durably hold the queued camera
// evidence File/Blob §25 requires alongside each queued action - and it
// survives closing the app and restarting the phone.
//
// Version 2 (owner 2026-09-29): a "keys" store holds the device's
// non-extractable queue encryption key, and a "refs" store the server ids
// a synced queued action produced (a clock in's session, a break's id)
// until the queued actions that depend on them are sent too.
const DB_NAME = "prosm_time_offline";
const DB_VERSION = 2;
const STORE_NAME = "offline_queue";
export const KEYS_STORE = "keys";
export const REFS_STORE = "refs";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "id" });
      if (!db.objectStoreNames.contains(KEYS_STORE)) db.createObjectStore(KEYS_STORE);
      if (!db.objectStoreNames.contains(REFS_STORE)) db.createObjectStore(REFS_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(store: string, mode: IDBTransactionMode, action: (s: IDBObjectStore) => IDBRequest | void): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const request = action(tx.objectStore(store));
      let result: T;
      if (request) request.onsuccess = () => (result = request.result as T);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function putItem<T extends { id: string }>(item: T): Promise<void> {
  await run<void>(STORE_NAME, "readwrite", (s) => s.put(item));
}

export async function deleteItem(id: string): Promise<void> {
  await run<void>(STORE_NAME, "readwrite", (s) => s.delete(id));
}

export async function getAllItems<T>(): Promise<T[]> {
  return (await run<T[]>(STORE_NAME, "readonly", (s) => s.getAll())) ?? [];
}

/** A value in the keys/refs stores (out-of-line keys). */
export async function getValue<T>(store: string, key: string): Promise<T | undefined> {
  return run<T | undefined>(store, "readonly", (s) => s.get(key));
}

export async function setValue(store: string, key: string, value: unknown): Promise<void> {
  await run<void>(store, "readwrite", (s) => s.put(value, key));
}

export async function deleteValue(store: string, key: string): Promise<void> {
  await run<void>(store, "readwrite", (s) => s.delete(key));
}
