import { getAllItems, putItem, deleteItem, getValue, setValue, deleteValue, REFS_STORE } from "./db";
import { seal, open, encodeJson, decodeJson, type Sealed } from "./queueCrypto";
import AttendanceRepository from "../repositories/AttendanceRepository";
import EvidenceRepository from "../repositories/EvidenceRepository";

export type OfflineActionType = "clock_in" | "clock_out" | "start_break" | "end_break" | "change_site";
export type OfflineQueueStatus = "pending" | "syncing" | "failed";

export interface OfflineQueueItem {
  id: string;
  userId: string;
  type: OfflineActionType;
  siteId: string | null;
  manualLocationLabel: string | null;
  note: string | null;
  activity: string | null;
  projectId: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  clientReportedAt: string;
  evidenceFile: File | null;
  /** start_break: the session (a server id, or "q:<id>" of a queued clock in). */
  sessionRef?: string | null;
  /** end_break / change_site: the break to end (a server id, or "q:<id>" of a queued break start). */
  breakRef?: string | null;
  /** change_site: the new site (null = no registered site, with manualLocationLabel). */
  newSiteId?: string | null;
  status: OfflineQueueStatus;
  errorMessage: string | null;
  createdAt: string;
  /** Set once the server has recorded the action: only its photo is left to send. */
  serverEventId?: string | null;
}

export type EnqueueInput = Omit<OfflineQueueItem, "id" | "status" | "errorMessage" | "createdAt" | "serverEventId">;

// What is stored: the listing fields in the clear, everything else (location, note, site,
// photo) sealed with the device key. Items written by earlier versions (no `v`) are read as is.
interface StoredItem {
  v: 2;
  id: string;
  userId: string;
  type: OfflineActionType;
  status: OfflineQueueStatus;
  errorMessage: string | null;
  createdAt: string;
  serverEventId: string | null;
  payload: Sealed | Record<string, unknown>;
  evidence: { sealed: Sealed | null; plain: Blob | null; type: string; name: string } | null;
}

type SensitiveFields = Omit<OfflineQueueItem, "id" | "userId" | "type" | "status" | "errorMessage" | "createdAt" | "serverEventId" | "evidenceFile">;

async function toStored(item: OfflineQueueItem): Promise<StoredItem> {
  const { id, userId, type, status, errorMessage, createdAt, serverEventId, evidenceFile, ...sensitive } = item;
  const sealedPayload = await seal(encodeJson(sensitive));
  let evidence: StoredItem["evidence"] = null;
  if (evidenceFile) {
    const bytes = await evidenceFile.arrayBuffer();
    const sealedEvidence = await seal(bytes);
    evidence = { sealed: sealedEvidence, plain: sealedEvidence ? null : evidenceFile, type: evidenceFile.type, name: evidenceFile.name };
  }
  return { v: 2, id, userId, type, status, errorMessage, createdAt, serverEventId: serverEventId ?? null, payload: sealedPayload ?? (sensitive as Record<string, unknown>), evidence };
}

const isSealed = (value: unknown): value is Sealed => !!value && typeof value === "object" && "iv" in value && "data" in value;

async function fromStored(raw: StoredItem | OfflineQueueItem): Promise<OfflineQueueItem> {
  if ((raw as StoredItem).v !== 2) return { sessionRef: null, breakRef: null, newSiteId: null, serverEventId: null, ...(raw as OfflineQueueItem) };
  const s = raw as StoredItem;
  const sensitive = isSealed(s.payload) ? decodeJson<SensitiveFields>(await open(s.payload)) : (s.payload as unknown as SensitiveFields);
  let evidenceFile: File | null = null;
  if (s.evidence) {
    const blob = s.evidence.sealed ? new Blob([await open(s.evidence.sealed)], { type: s.evidence.type }) : s.evidence.plain;
    if (blob) evidenceFile = new File([blob], s.evidence.name, { type: s.evidence.type });
  }
  return { ...sensitive, id: s.id, userId: s.userId, type: s.type, status: s.status, errorMessage: s.errorMessage, createdAt: s.createdAt, serverEventId: s.serverEventId, evidenceFile };
}

// Only the listing fields change on a status update; the sealed payload is kept as it is.
async function setStatus(id: string, patch: Partial<Pick<StoredItem, "status" | "errorMessage" | "serverEventId">>): Promise<void> {
  const all = await getAllItems<StoredItem | OfflineQueueItem>();
  const current = all.find((x) => x.id === id);
  if (!current) return;
  await putItem({ ...current, ...patch } as StoredItem);
}

interface ResolvedRef {
  sessionId?: string;
  breakId?: string;
}

const isQueued = (ref: string | null | undefined): ref is string => typeof ref === "string" && ref.startsWith("q:");

type Listener = (items: OfflineQueueItem[]) => void;

// PROSM Time WP-15/§25/§34 - the client-side "offline_sync_queue".
// Owner 2026-09-29: every attendance action a worker takes without a connection is kept here in
// order - clock in/out, break start/end, site change - and replayed in the same order once the
// connection returns. Each action carries its own id (the server's idempotency key, so a resend is
// never recorded twice) and the time it really happened. A later action that needs an earlier
// queued one's server id (a break in a session clocked in offline) resolves it at sync time.
// A connection failure leaves the action pending; a refusal by the server marks it failed (kept,
// shown, retried or discarded by the worker) and stops that worker's later actions so their order
// is never broken.
class OfflineQueueService {
  private listeners = new Set<Listener>();
  private flushing = false;
  private recovered = false;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    this.list().then(listener).catch(() => listener([]));
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async notify(): Promise<void> {
    const items = await this.list().catch(() => [] as OfflineQueueItem[]);
    this.listeners.forEach((listener) => listener(items));
  }

  // An action left "syncing" by an app closed mid-sync is pending again (its id makes a resend safe).
  private async recover(): Promise<void> {
    if (this.recovered) return;
    this.recovered = true;
    const all = await getAllItems<StoredItem | OfflineQueueItem>();
    for (const item of all) if (item.status === "syncing") await putItem({ ...item, status: "pending" } as StoredItem);
  }

  async list(): Promise<OfflineQueueItem[]> {
    await this.recover();
    const raw = await getAllItems<StoredItem | OfflineQueueItem>();
    const items = await Promise.all(raw.map(fromStored));
    return items.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id));
  }

  async listForUser(userId: string): Promise<OfflineQueueItem[]> {
    return (await this.list()).filter((item) => item.userId === userId);
  }

  async enqueue(input: EnqueueInput): Promise<OfflineQueueItem> {
    const item: OfflineQueueItem = {
      ...input,
      id: crypto.randomUUID(),
      status: "pending",
      errorMessage: null,
      createdAt: new Date().toISOString(),
      serverEventId: null,
    };
    await putItem(await toStored(item));
    await this.notify();
    return item;
  }

  async discard(id: string): Promise<void> {
    await deleteItem(id);
    await this.notify();
  }

  // Re-attempts one item regardless of its current status - the only path back from "failed"
  // (a real server rejection, never retried on its own), then the rest of that worker's queue.
  async retry(id: string): Promise<void> {
    await setStatus(id, { status: "pending", errorMessage: null });
    await this.notify();
    await this.flush();
  }

  // Auto-invoked on app start, on the browser's `online` event, and on a light interval
  // fallback (§25: browsers don't always fire `online` reliably on flaky connections).
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const items = await this.list();
      const stopped = new Set<string>();
      for (const item of items) {
        if (stopped.has(item.userId)) continue;
        if (item.status === "failed") {
          stopped.add(item.userId);
          continue;
        }
        if (typeof navigator !== "undefined" && navigator.onLine === false) break;
        const outcome = await this.syncItem(item);
        if (outcome !== "done") stopped.add(item.userId);
      }
      if (items.length > 0 && (await getAllItems()).length === 0) await this.clearRefs(items.map((i) => i.id));
    } finally {
      this.flushing = false;
    }
  }

  private async clearRefs(ids: string[]): Promise<void> {
    for (const id of ids) await deleteValue(REFS_STORE, id).catch(() => undefined);
  }

  private async resolve(ref: string | null | undefined, field: keyof ResolvedRef): Promise<string | null | "missing"> {
    if (!ref) return null;
    if (!isQueued(ref)) return ref;
    const resolved = await getValue<ResolvedRef>(REFS_STORE, ref.slice(2));
    return resolved?.[field] ?? "missing";
  }

  private async syncItem(item: OfflineQueueItem): Promise<"done" | "wait" | "failed"> {
    await setStatus(item.id, { status: "syncing" });
    await this.notify();

    const fail = async (message: string | null) => {
      await setStatus(item.id, { status: "failed", errorMessage: message ?? "Sync failed." });
      await this.notify();
      return "failed" as const;
    };
    const wait = async () => {
      await setStatus(item.id, { status: "pending" });
      await this.notify();
      return "wait" as const;
    };

    // Already recorded by the server on an earlier attempt: only the photo is left to send.
    let eventId = item.serverEventId ?? null;
    if (!eventId) {
      const options = { idempotencyKey: item.id, clientReportedAt: item.clientReportedAt };
      let result: { success: boolean; message: string | null; networkError?: boolean; data: unknown };
      if (item.type === "clock_in") {
        result = await AttendanceRepository.clockIn({ siteId: item.siteId, manualLocationLabel: item.manualLocationLabel, note: item.note, activity: item.activity, projectId: item.projectId, latitude: item.latitude, longitude: item.longitude, accuracyMeters: item.accuracyMeters, ...options });
        if (result.success && result.data) await setValue(REFS_STORE, item.id, { sessionId: (result.data as { sessionId: string }).sessionId });
      } else if (item.type === "clock_out") {
        result = await AttendanceRepository.clockOut({ latitude: item.latitude, longitude: item.longitude, accuracyMeters: item.accuracyMeters, note: item.note, activity: item.activity, ...options });
      } else if (item.type === "start_break") {
        const sessionId = await this.resolve(item.sessionRef, "sessionId");
        if (!sessionId || sessionId === "missing") return fail("The clock in this break belongs to was not sent.");
        result = await AttendanceRepository.startBreak(sessionId, options);
        if (result.success && result.data) await setValue(REFS_STORE, item.id, { breakId: (result.data as { breakId: string }).breakId });
      } else if (item.type === "end_break") {
        const breakId = await this.resolve(item.breakRef, "breakId");
        if (!breakId || breakId === "missing") return fail("The break start this end belongs to was not sent.");
        result = await AttendanceRepository.endBreak(breakId, options);
      } else {
        const breakId = await this.resolve(item.breakRef, "breakId");
        if (breakId === "missing") return fail("The break start this site change belongs to was not sent.");
        result = await AttendanceRepository.changeSite(breakId, item.newSiteId ?? null, item.latitude, item.longitude, item.accuracyMeters, item.manualLocationLabel, options);
      }

      if (result.networkError) return wait();
      if (!result.success) return fail(result.message);
      eventId = (result.data as { eventId?: string } | null)?.eventId ?? null;
    }

    if (item.evidenceFile && eventId) {
      await setStatus(item.id, { serverEventId: eventId });
      const upload = await EvidenceRepository.uploadEvidence(eventId, item.evidenceFile);
      if (!upload.success) {
        // Kept until the photo is sent: a connection problem waits, anything else is shown.
        if (typeof navigator !== "undefined" && navigator.onLine === false) return wait();
        return fail(upload.message ?? "The photo could not be sent.");
      }
    }

    await deleteItem(item.id);
    await this.notify();
    return "done";
  }
}

export default new OfflineQueueService();
