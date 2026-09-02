import { getAllItems, putItem, deleteItem } from "./db";
import AttendanceRepository from "../repositories/AttendanceRepository";
import EvidenceRepository from "../repositories/EvidenceRepository";

export type OfflineActionType = "clock_in" | "clock_out";
export type OfflineQueueStatus = "pending" | "syncing" | "failed";

export interface OfflineQueueItem {
  id: string;
  userId: string;
  type: OfflineActionType;
  siteId: string | null;
  manualLocationLabel: string | null;
  projectId: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  clientReportedAt: string;
  evidenceFile: File | null;
  status: OfflineQueueStatus;
  errorMessage: string | null;
  createdAt: string;
}

export type EnqueueInput = Omit<OfflineQueueItem, "id" | "status" | "errorMessage" | "createdAt">;

type Listener = (items: OfflineQueueItem[]) => void;

// PROSM Time WP-15/§25/§34 - the client-side "offline_sync_queue".
// One pending item per user by design: a queued Clock Out can only
// ever replay meaningfully once its own Clock In (if that was also
// queued) has actually produced a real server-side session id, so
// this queue deliberately never lets two causally-dependent actions
// pile up unsynced rather than trying to model that ordering.
class OfflineQueueService {
  private listeners = new Set<Listener>();
  private flushing = false;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    this.list().then(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async notify(): Promise<void> {
    const items = await this.list();
    this.listeners.forEach((listener) => listener(items));
  }

  async list(): Promise<OfflineQueueItem[]> {
    const items = await getAllItems<OfflineQueueItem>();
    return items.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }

  async listForUser(userId: string): Promise<OfflineQueueItem[]> {
    return (await this.list()).filter((item) => item.userId === userId);
  }

  async enqueue(input: EnqueueInput): Promise<OfflineQueueItem> {
    const existing = await this.listForUser(input.userId);
    if (existing.length > 0) {
      throw new Error("A previous offline action is still pending sync.");
    }

    const item: OfflineQueueItem = {
      ...input,
      id: crypto.randomUUID(),
      status: "pending",
      errorMessage: null,
      createdAt: new Date().toISOString(),
    };

    await putItem(item);
    await this.notify();
    return item;
  }

  async discard(id: string): Promise<void> {
    await deleteItem(id);
    await this.notify();
  }

  // Re-attempts one item regardless of its current status - the only
  // path back from "failed" (a real server rejection, not a
  // connectivity issue, so it never auto-retries on its own).
  async retry(id: string): Promise<void> {
    const item = (await this.list()).find((entry) => entry.id === id);
    if (!item) return;
    await this.syncItem({ ...item, status: "pending", errorMessage: null });
  }

  // Auto-invoked on mount, on the browser's `online` event, and on a
  // light interval fallback (§25: browsers don't always fire `online`
  // reliably on flaky connections). Only ever touches "pending" items
  // - a "failed" item requires the explicit retry() above so a real
  // server rejection is never silently retried forever.
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const items = await this.list();
      for (const item of items) {
        if (item.status !== "pending") continue;
        if (typeof navigator !== "undefined" && navigator.onLine === false) break;
        await this.syncItem(item);
      }
    } finally {
      this.flushing = false;
    }
  }

  private async syncItem(item: OfflineQueueItem): Promise<void> {
    await putItem({ ...item, status: "syncing" });
    await this.notify();

    const result =
      item.type === "clock_in"
        ? await AttendanceRepository.clockIn({
            siteId: item.siteId,
            manualLocationLabel: item.manualLocationLabel,
            projectId: item.projectId,
            latitude: item.latitude,
            longitude: item.longitude,
            accuracyMeters: item.accuracyMeters,
            idempotencyKey: item.id,
            clientReportedAt: item.clientReportedAt,
          })
        : await AttendanceRepository.clockOut({
            latitude: item.latitude,
            longitude: item.longitude,
            accuracyMeters: item.accuracyMeters,
            idempotencyKey: item.id,
            clientReportedAt: item.clientReportedAt,
          });

    if (result.networkError) {
      await putItem({ ...item, status: "pending" });
      await this.notify();
      return;
    }

    if (!result.success || !result.data) {
      await putItem({ ...item, status: "failed", errorMessage: result.message ?? "Sync failed." });
      await this.notify();
      return;
    }

    if (item.evidenceFile) {
      await EvidenceRepository.uploadEvidence(result.data.eventId, item.evidenceFile);
    }

    await deleteItem(item.id);
    await this.notify();
  }
}

export default new OfflineQueueService();
