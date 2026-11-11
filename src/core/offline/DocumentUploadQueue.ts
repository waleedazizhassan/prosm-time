import { getValue, setValue, deleteValue, REFS_STORE } from "./db";
import DocumentsRepository from "../repositories/DocumentsRepository";
import EmployeeProfileRepository from "../repositories/EmployeeProfileRepository";

// HR suite feature 2 (2026-11-11): "the employee photographs the document on the phone - and it must work
// offline, sent when the connection returns, like clock-in". A document taken without a connection is
// kept on the phone (the same local store as the attendance queue) and sent later, once: its id is the
// server's client_ref, so a resend is never recorded twice.

export interface QueuedDocument {
  id: string;
  organizationId: string;
  userId: string;
  typeId: string;
  typeName: string;
  documentNumber: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  file: Blob;
  fileName: string;
  createdAt: string;
  error?: string | null;
  /** who queued it (a personnel manager may upload for someone else) */
  submittedBy?: string | null;
}

const INDEX = "docq:index";
const key = (id: string) => `docq:${id}`;
type Listener = () => void;
const listeners = new Set<Listener>();
let flushing = false;

async function ids(): Promise<string[]> {
  return (await getValue<string[]>(REFS_STORE, INDEX)) ?? [];
}

const DocumentUploadQueue = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  async list(userId: string): Promise<QueuedDocument[]> {
    return (await this.all()).filter((x) => x.userId === userId);
  },

  async all(): Promise<QueuedDocument[]> {
    const all = await Promise.all((await ids()).map((id) => getValue<QueuedDocument>(REFS_STORE, key(id))));
    return all.filter((x): x is QueuedDocument => Boolean(x));
  },

  async enqueue(item: Omit<QueuedDocument, "id" | "createdAt">): Promise<QueuedDocument> {
    const queued: QueuedDocument = { ...item, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    await setValue(REFS_STORE, key(queued.id), queued);
    await setValue(REFS_STORE, INDEX, [...(await ids()), queued.id]);
    listeners.forEach((l) => l());
    return queued;
  },

  async remove(id: string): Promise<void> {
    await deleteValue(REFS_STORE, key(id));
    await setValue(REFS_STORE, INDEX, (await ids()).filter((x) => x !== id));
    listeners.forEach((l) => l());
  },

  /** Send what this signed-in person queued (for themselves or, as personnel, for someone else). */
  async flush(userId: string | null | undefined): Promise<void> {
    if (!userId || flushing || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
    const mine = (await this.all()).filter((x) => !x.error && (x.submittedBy ?? x.userId) === userId);
    if (mine.length === 0) return;
    flushing = true;
    try {
      for (const item of mine) {
        const ext = item.fileName.split(".").pop() ?? "jpg";
        const uploaded = await EmployeeProfileRepository.uploadFile(item.organizationId, item.userId, item.file, ext);
        if (uploaded.error && !/fetch|network|Failed/i.test(uploaded.error)) {
          // the file itself was refused (type or size): set aside with the reason, never blocks the rest
          await setValue(REFS_STORE, key(item.id), { ...item, error: uploaded.error });
          continue;
        }
        if (uploaded.error || !uploaded.data) break; // still offline: try again later
        const sent = await DocumentsRepository.submit(item.userId, item.typeId, {
          file_path: uploaded.data, document_number: item.documentNumber, issue_date: item.issueDate, expiry_date: item.expiryDate, client_ref: item.id,
        });
        if (sent.error && /fetch|network|Failed/i.test(sent.error)) break;
        if (sent.error) {
          // refused by the server (for example a type no longer required): kept with the reason, shown, removable
          await setValue(REFS_STORE, key(item.id), { ...item, error: sent.error });
          continue;
        }
        await this.remove(item.id);
      }
    } finally {
      flushing = false;
      listeners.forEach((l) => l());
    }
  },
};

export default DocumentUploadQueue;
