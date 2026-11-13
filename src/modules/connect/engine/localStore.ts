import { seal, open, encodeJson, decodeJson, type Sealed } from "../../../core/offline/queueCrypto";

// PROSM Connect (owner 2026-11-13): conversations live on the person's own device. One IndexedDB database per signed-
// in person, every message and file sealed with the device's AES-GCM key (the same non-extractable key that protects
// the offline attendance queue); only what is needed to sort and count stays readable (ids, conversation, time,
// status, kind, size). On sign-out the person's Connect data on this device is removed.

export type MessageStatus = "pending" | "sent" | "delivered" | "read" | "failed";
export type MessageKind = "message" | "image" | "camera_photo" | "file" | "voice_note" | "push_to_talk" | "site_broadcast" | "photo_request" | "missed" | "meeting_invite" | "call_log";

export interface LocalMessage {
  id: string; // the sender's client id: the same on every device
  conversationId: string;
  fromUser: string;
  kind: MessageKind;
  createdAt: string;
  status: MessageStatus;
  mine: boolean;
  sizeBytes: number;
  // sealed below: text, file name, type, duration, proof code, meeting id...
  body?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  durationMs?: number | null;
  proofCode?: string | null;
  refId?: string | null;
  hasBlob?: boolean;
}

export interface LocalConversation {
  id: string;
  kind: "direct" | "group" | "site";
  otherUserId: string | null;
  title: string | null;
  lastAt: string;
  lastPreview: string;
  unread: number;
}

interface StoredMessage {
  id: string;
  conversationId: string;
  createdAt: string;
  status: MessageStatus;
  mine: boolean;
  kind: MessageKind;
  sizeBytes: number;
  fromUser: string;
  sealed?: Sealed | null;
  plain?: string | null;
}

export interface OutboxEntry {
  id: string;
  conversationId: string;
  kind: MessageKind;
  body: string | null;
  fileName: string | null;
  mimeType: string | null;
  durationMs: number | null;
  proofCode: string | null;
  createdAt: string;
  tries: number;
}

const VERSION = 1;
let dbPromise: Promise<IDBDatabase> | null = null;
let dbOwner: string | null = null;

function dbName(userId: string) {
  return `prosm_connect_${userId}`;
}

function openDb(userId: string): Promise<IDBDatabase> {
  if (dbPromise && dbOwner === userId) return dbPromise;
  dbOwner = userId;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName(userId), VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const messages = db.createObjectStore("messages", { keyPath: "id" });
      messages.createIndex("byConversation", ["conversationId", "createdAt"]);
      db.createObjectStore("conversations", { keyPath: "id" });
      db.createObjectStore("outbox", { keyPath: "id" });
      db.createObjectStore("blobs");
      db.createObjectStore("meta");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function tx<T>(userId: string, store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return openDb(userId).then((db) => new Promise<T | undefined>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const request = run(t.objectStore(store));
    t.oncomplete = () => resolve(request ? (request as IDBRequest<T>).result : undefined);
    t.onerror = () => reject(t.error);
  }));
}

async function sealJson(value: unknown): Promise<{ sealed: Sealed | null; plain: string | null }> {
  const sealedValue = await seal(encodeJson(value));
  return sealedValue ? { sealed: sealedValue, plain: null } : { sealed: null, plain: JSON.stringify(value) };
}

async function openJson<T>(stored: { sealed?: Sealed | null; plain?: string | null }): Promise<T | null> {
  try {
    if (stored.sealed) return decodeJson<T>(await open(stored.sealed));
    return stored.plain ? (JSON.parse(stored.plain) as T) : null;
  } catch {
    return null;
  }
}

export const LocalStore = {
  async putMessage(userId: string, message: LocalMessage): Promise<void> {
    const { body, fileName, mimeType, durationMs, proofCode, refId, hasBlob, ...meta } = message;
    const secret = await sealJson({ body, fileName, mimeType, durationMs, proofCode, refId, hasBlob });
    const stored: StoredMessage = { ...meta, ...secret };
    await tx(userId, "messages", "readwrite", (s) => s.put(stored));
  },

  async setStatus(userId: string, id: string, status: MessageStatus): Promise<LocalMessage | null> {
    const current = await tx<StoredMessage>(userId, "messages", "readonly", (s) => s.get(id));
    if (!current) return null;
    const order: MessageStatus[] = ["failed", "pending", "sent", "delivered", "read"];
    if (status !== "failed" && order.indexOf(status) <= order.indexOf(current.status)) return null;
    await tx(userId, "messages", "readwrite", (s) => s.put({ ...current, status }));
    return LocalStore.decode({ ...current, status });
  },

  async decode(stored: StoredMessage): Promise<LocalMessage> {
    const secret = (await openJson<Partial<LocalMessage>>(stored)) ?? {};
    return { ...stored, ...secret } as LocalMessage;
  },

  async messages(userId: string, conversationId: string, limit = 300): Promise<LocalMessage[]> {
    const rows = await openDb(userId).then((db) => new Promise<StoredMessage[]>((resolve, reject) => {
      const t = db.transaction("messages", "readonly");
      const range = IDBKeyRange.bound([conversationId, ""], [conversationId, "￿"]);
      const request = t.objectStore("messages").index("byConversation").getAll(range);
      request.onsuccess = () => resolve(request.result as StoredMessage[]);
      request.onerror = () => reject(request.error);
    }));
    const slice = rows.slice(-limit);
    return Promise.all(slice.map((row) => LocalStore.decode(row)));
  },

  async hasMessage(userId: string, id: string): Promise<boolean> {
    return Boolean(await tx<StoredMessage>(userId, "messages", "readonly", (s) => s.get(id)));
  },

  async putBlob(userId: string, id: string, blob: Blob): Promise<void> {
    const sealedValue = await seal(await blob.arrayBuffer());
    await tx(userId, "blobs", "readwrite", (s) => s.put(sealedValue ? { sealed: sealedValue, type: blob.type } : { blob, type: blob.type }, id));
  },

  async getBlob(userId: string, id: string): Promise<Blob | null> {
    const stored = await tx<{ sealed?: Sealed; blob?: Blob; type: string }>(userId, "blobs", "readonly", (s) => s.get(id));
    if (!stored) return null;
    if (stored.blob) return stored.blob;
    try {
      return new Blob([await open(stored.sealed!)], { type: stored.type });
    } catch {
      return null;
    }
  },

  async conversations(userId: string): Promise<LocalConversation[]> {
    const rows = (await tx<LocalConversation[]>(userId, "conversations", "readonly", (s) => s.getAll())) ?? [];
    return rows.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
  },

  async getConversation(userId: string, id: string): Promise<LocalConversation | null> {
    return (await tx<LocalConversation>(userId, "conversations", "readonly", (s) => s.get(id))) ?? null;
  },

  async putConversation(userId: string, conversation: LocalConversation): Promise<void> {
    await tx(userId, "conversations", "readwrite", (s) => s.put(conversation));
  },

  async outbox(userId: string): Promise<OutboxEntry[]> {
    return ((await tx<OutboxEntry[]>(userId, "outbox", "readonly", (s) => s.getAll())) ?? []).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  },

  async putOutbox(userId: string, entry: OutboxEntry): Promise<void> {
    await tx(userId, "outbox", "readwrite", (s) => s.put(entry));
  },

  async dropOutbox(userId: string, id: string): Promise<void> {
    await tx(userId, "outbox", "readwrite", (s) => s.delete(id));
  },

  /** Sizes by kind, for the storage screen. */
  async usage(userId: string): Promise<Record<string, number>> {
    const rows = (await tx<StoredMessage[]>(userId, "messages", "readonly", (s) => s.getAll())) ?? [];
    const sizes: Record<string, number> = { messages: 0, images: 0, video: 0, files: 0, voice: 0 };
    for (const row of rows) {
      const bucket = row.kind === "image" || row.kind === "camera_photo" ? "images" : row.kind === "voice_note" || row.kind === "push_to_talk" ? "voice" : row.kind === "file" ? "files" : "messages";
      sizes[bucket] += row.sizeBytes || 200;
    }
    return sizes;
  },

  /** Removes the files of a kind (or of one conversation); the messages stay, marked without their file. */
  async clean(userId: string, kinds: MessageKind[], conversationId?: string): Promise<number> {
    const rows = (await tx<StoredMessage[]>(userId, "messages", "readonly", (s) => s.getAll())) ?? [];
    let freed = 0;
    for (const row of rows) {
      if (!kinds.includes(row.kind) || (conversationId && row.conversationId !== conversationId)) continue;
      await tx(userId, "blobs", "readwrite", (s) => s.delete(row.id));
      freed += row.sizeBytes;
      await tx(userId, "messages", "readwrite", (s) => s.put({ ...row, sizeBytes: 0 }));
    }
    return freed;
  },

  /** Sign-out: the person's Connect data leaves this device. */
  async wipe(userId: string): Promise<void> {
    if (dbOwner === userId && dbPromise) {
      (await dbPromise).close();
      dbPromise = null;
      dbOwner = null;
    }
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(dbName(userId));
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
  },
};
