import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

import DatabaseManager from "../../../core/database/DatabaseManager";
import ConnectRepository, { type ConnectItem } from "../../../core/repositories/ConnectRepository";
import { LocalStore, type LocalConversation, type LocalMessage, type MessageKind, type OutboxEntry } from "./localStore";

// PROSM Connect (owner 2026-11-13) - the device's side of the switchboard. One per signed-in person:
//   * listens on the person's private channel (connect:user:<id>) and, as a fallback, reads the inbox when the app
//     opens, every half minute, and when the connection returns;
//   * keeps every message on the device (sealed), downloads its file from the temporary bucket, then says
//     "received" - the server lets the request go;
//   * sends from an outbox: a message written offline goes by itself when the connection returns (🕓 → ✓ → ✓✓);
//   * carries "arrived" and "read" back to the sender, and passes calls and invitations to the call screens.

export interface IncomingCall { callId: string; fromUser: string; media: "audio" | "video"; itemId: string }
export interface MeetingInvite { meetingId: string; fromUser: string; media: "audio" | "video"; title: string | null }
type Listener = (detail: unknown) => void;

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);
const TEXT_KINDS = new Set(["message", "site_broadcast", "photo_request", "missed", "meeting_invite"]);

class Engine {
  me: { userId: string; orgId: string } | null = null;
  private client: SupabaseClient | null = null;
  private channel: RealtimeChannel | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private directCache = new Map<string, string>();
  private seenCalls = new Set<string>();
  private flushing = false;
  private draining = false;
  private timer: number | null = null;
  openConversation: string | null = null;

  on(event: string, listener: Listener): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return () => this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, detail?: unknown) {
    this.listeners.get(event)?.forEach((listener) => {
      try {
        listener(detail);
      } catch {
        // one screen's error never stops the others
      }
    });
  }

  get supabase(): SupabaseClient {
    if (!this.client) this.client = DatabaseManager.getClient() as unknown as SupabaseClient;
    return this.client;
  }

  async start(userId: string, orgId: string) {
    if (this.me?.userId === userId && this.channel) return;
    await this.stop();
    this.me = { userId, orgId };
    // the screens that read before the engine was ready read again now
    this.emit("conversations");
    try {
      const session = (await this.supabase.auth.getSession()).data.session;
      if (session) await this.supabase.realtime.setAuth(session.access_token);
    } catch {
      // the channel retries with the session it has
    }
    const channel = this.supabase.channel(`connect:user:${userId}`, { config: { private: true } });
    channel
      .on("broadcast", { event: "item" }, (message) => void this.fetchAndHandle((message.payload as { id: string }).id))
      .on("broadcast", { event: "receipt" }, (message) => void this.handleReceipt(message.payload as Record<string, unknown>))
      .on("broadcast", { event: "call" }, (message) => this.emit("call-signal", message.payload))
      .subscribe((status) => {
        if (status === "SUBSCRIBED") void this.drain();
      });
    this.channel = channel;
    window.addEventListener("online", this.onOnline);
    this.timer = window.setInterval(() => {
      void this.drain();
      void this.flush();
    }, 30000);
    void this.drain();
    void this.flush();
  }

  async stop() {
    if (this.channel) await this.supabase.removeChannel(this.channel).catch(() => undefined);
    this.channel = null;
    if (this.timer) window.clearInterval(this.timer);
    this.timer = null;
    window.removeEventListener("online", this.onOnline);
    this.me = null;
  }

  private onOnline = () => {
    void this.drain();
    void this.flush();
  };

  // ---- receiving ------------------------------------------------------------------------------------------------
  private async fetchAndHandle(itemId: string) {
    const { data } = await this.supabase.from("connect_switchboard").select("*").eq("id", itemId).maybeSingle();
    if (data) await this.handle(mapRow(data as Record<string, unknown>));
  }

  async drain() {
    if (!this.me || this.draining) return;
    this.draining = true;
    try {
      const items = await ConnectRepository.inbox();
      for (const item of items) await this.handle(item);
    } finally {
      this.draining = false;
    }
  }

  private async handle(item: ConnectItem) {
    const me = this.me;
    if (!me || item.fromUser === me.userId) return;
    if (item.type === "audio_call" || item.type === "video_call") {
      // the live channel and the inbox can both bring the same call: it rings once
      if (item.refId && !this.seenCalls.has(item.refId)) {
        this.seenCalls.add(item.refId);
        this.emit("incoming-call", { callId: item.refId, fromUser: item.fromUser, media: item.type === "video_call" ? "video" : "audio", itemId: item.id } as IncomingCall);
      }
      return;
    }
    if (item.type === "meeting_invite" && item.refId && this.seenCalls.has(item.refId)) {
      await ConnectRepository.ack(item.id);
      return;
    }
    if (item.type === "meeting_invite" && item.refId) this.seenCalls.add(item.refId);
    if (item.type === "meeting_invite" && item.refId) {
      const [title, media] = (item.body ?? "").split("|");
      this.emit("meeting-invite", { meetingId: item.refId, fromUser: item.fromUser, media: media === "video" ? "video" : "audio", title: title || null } as MeetingInvite);
    }
    const id = item.clientId ?? item.id;
    if (await LocalStore.hasMessage(me.userId, id)) {
      await ConnectRepository.ack(item.id);
      return;
    }
    const conversationId = item.conversationId ?? (item.siteId ? `site:${item.siteId}` : await this.directWith(item.fromUser));
    if (!conversationId) return;
    let hasBlob = false;
    let size = (item.body ?? "").length;
    if (item.attachmentPath) {
      const { data: blob, error } = await this.supabase.storage.from("connect-temp").download(item.attachmentPath);
      if (error || !blob) return; // the file is still on its way: the next pass gets it, and only then "received"
      await LocalStore.putBlob(me.userId, id, blob);
      hasBlob = true;
      size = blob.size;
    }
    let meta: Record<string, unknown> = {};
    if (!TEXT_KINDS.has(item.type) && item.body) {
      try {
        meta = JSON.parse(item.body) as Record<string, unknown>;
      } catch {
        meta = {};
      }
    }
    const message: LocalMessage = {
      id, conversationId, fromUser: item.fromUser, kind: item.type as MessageKind, createdAt: item.createdAt,
      status: "delivered", mine: false, sizeBytes: size, hasBlob,
      body: TEXT_KINDS.has(item.type) ? item.body : (meta.caption as string | undefined) ?? null,
      fileName: (meta.fileName as string | undefined) ?? null, mimeType: item.mimeType,
      durationMs: (meta.durationMs as number | undefined) ?? null, proofCode: (meta.proofCode as string | undefined) ?? null,
      refId: item.refId,
    };
    await LocalStore.putMessage(me.userId, message);
    await this.touchConversation(conversationId, message, item.siteId ? "site" : "direct", item.fromUser, this.openConversation !== conversationId);
    await ConnectRepository.ack(item.id);
    this.emit("message", message);
    if (this.openConversation === conversationId) void this.markRead(conversationId);
  }

  private async handleReceipt(payload: Record<string, unknown>) {
    const me = this.me;
    if (!me) return;
    const state = payload.state === "read" ? "read" : "delivered";
    const ids = (payload.clientIds as string[] | undefined) ?? (payload.clientId ? [String(payload.clientId)] : []);
    for (const id of ids) {
      const updated = await LocalStore.setStatus(me.userId, id, state);
      if (updated) this.emit("status", updated);
    }
  }

  /** Opening a conversation: its messages are read; their senders hear it. */
  async markRead(conversationId: string) {
    const me = this.me;
    if (!me) return;
    const conversation = await LocalStore.getConversation(me.userId, conversationId);
    if (conversation && conversation.unread > 0) {
      await LocalStore.putConversation(me.userId, { ...conversation, unread: 0 });
      this.emit("conversations");
    }
    const messages = await LocalStore.messages(me.userId, conversationId, 200);
    const bySender = new Map<string, string[]>();
    for (const m of messages) {
      if (m.mine || m.status === "read") continue;
      await LocalStore.setStatus(me.userId, m.id, "read");
      bySender.set(m.fromUser, [...(bySender.get(m.fromUser) ?? []), m.id]);
    }
    for (const [sender, ids] of bySender) {
      await this.supabase.rpc("prosm_time_connect_mark_read", { p_sender: sender, p_client_ids: ids });
    }
  }

  // ---- conversations --------------------------------------------------------------------------------------------
  async directWith(userId: string): Promise<string | null> {
    if (this.directCache.has(userId)) return this.directCache.get(userId)!;
    const result = await ConnectRepository.openDirect(userId);
    if (result.id) {
      this.directCache.set(userId, result.id);
      const me = this.me;
      if (me && !(await LocalStore.getConversation(me.userId, result.id))) {
        await LocalStore.putConversation(me.userId, { id: result.id, kind: "direct", otherUserId: userId, title: null, lastAt: new Date(0).toISOString(), lastPreview: "", unread: 0 });
      }
      this.emit("conversations");
    }
    return result.id;
  }

  private async touchConversation(id: string, message: LocalMessage, kind: LocalConversation["kind"], otherUserId: string | null, countUnread: boolean) {
    const me = this.me!;
    const current = await LocalStore.getConversation(me.userId, id);
    await LocalStore.putConversation(me.userId, {
      id, kind: current?.kind ?? kind, otherUserId: current?.otherUserId ?? (kind === "direct" ? otherUserId : null), title: current?.title ?? null,
      lastAt: message.createdAt, lastPreview: preview(message), unread: (current?.unread ?? 0) + (countUnread && !message.mine ? 1 : 0),
    });
    this.emit("conversations");
  }

  // ---- sending --------------------------------------------------------------------------------------------------
  /** Writes the message on the device at once (🕓) and sends it when it can. */
  async send(conversationId: string, kind: MessageKind, input: { body?: string | null; blob?: Blob | null; fileName?: string | null; durationMs?: number | null; proofCode?: string | null; otherUserId?: string | null }) {
    const me = this.me;
    if (!me) throw new Error("Connect is not started.");
    const id = uuid();
    const createdAt = new Date().toISOString();
    if (input.blob) await LocalStore.putBlob(me.userId, id, input.blob);
    const message: LocalMessage = {
      id, conversationId, fromUser: me.userId, kind, createdAt, status: "pending", mine: true,
      sizeBytes: input.blob?.size ?? (input.body ?? "").length, body: input.body ?? null, fileName: input.fileName ?? null,
      mimeType: input.blob?.type ?? null, durationMs: input.durationMs ?? null, proofCode: input.proofCode ?? null, hasBlob: Boolean(input.blob),
    };
    await LocalStore.putMessage(me.userId, message);
    await this.touchConversation(conversationId, message, conversationId.startsWith("site:") ? "site" : "direct", input.otherUserId ?? null, false);
    const entry: OutboxEntry = { id, conversationId, kind, body: input.body ?? null, fileName: input.fileName ?? null, mimeType: input.blob?.type ?? null, durationMs: input.durationMs ?? null, proofCode: input.proofCode ?? null, createdAt, tries: 0 };
    await LocalStore.putOutbox(me.userId, entry);
    this.emit("message", message);
    void this.flush();
    return message;
  }

  /** Kept on this device only, never sent (a meeting recording - owner: "never uploaded to the server"). */
  async saveLocal(conversationId: string, kind: MessageKind, blob: Blob, fileName: string) {
    const me = this.me;
    if (!me) return null;
    const id = uuid();
    await LocalStore.putBlob(me.userId, id, blob);
    const message: LocalMessage = { id, conversationId, fromUser: me.userId, kind, createdAt: new Date().toISOString(), status: "sent", mine: true, sizeBytes: blob.size, fileName, mimeType: blob.type, hasBlob: true };
    await LocalStore.putMessage(me.userId, message);
    await LocalStore.putConversation(me.userId, { id: conversationId, kind: "group", otherUserId: null, title: null, lastAt: message.createdAt, lastPreview: preview(message), unread: 0 });
    this.emit("conversations");
    this.emit("message", message);
    return message;
  }

  /** A request to a person that is not a conversation message (photo request). */
  async sendTo(toUser: string, type: "photo_request", body: string | null) {
    const me = this.me;
    if (!me) return false;
    const { error } = await this.supabase.from("connect_switchboard").insert({ organization_id: me.orgId, from_user: me.userId, to_user: toUser, type, body, client_id: uuid() });
    return !error;
  }

  async flush() {
    const me = this.me;
    if (!me || this.flushing || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
    this.flushing = true;
    try {
      for (const entry of await LocalStore.outbox(me.userId)) {
        const ok = await this.sendOne(entry);
        if (!ok) {
          await LocalStore.putOutbox(me.userId, { ...entry, tries: entry.tries + 1 });
          if (entry.tries + 1 >= 20) {
            await LocalStore.dropOutbox(me.userId, entry.id);
            const failed = await LocalStore.setStatus(me.userId, entry.id, "failed");
            if (failed) this.emit("status", failed);
          }
          break; // keep the order: the next ones wait for this one
        }
        await LocalStore.dropOutbox(me.userId, entry.id);
        const sent = await LocalStore.setStatus(me.userId, entry.id, "sent");
        if (sent) this.emit("status", sent);
      }
    } finally {
      this.flushing = false;
    }
  }

  private async sendOne(entry: OutboxEntry): Promise<boolean> {
    const me = this.me!;
    const itemId = uuid();
    const site = entry.conversationId.startsWith("site:") ? entry.conversationId.slice(5) : null;
    const blob = entry.mimeType ? await LocalStore.getBlob(me.userId, entry.id) : null;
    const safeName = (entry.fileName ?? "file").replace(/[^\w.-]+/g, "_").slice(-80) || "file";
    const path = blob ? `${me.orgId}/${itemId}/${safeName}` : null;
    const body = TEXT_KINDS.has(entry.kind)
      ? entry.body
      : JSON.stringify({ caption: entry.body ?? undefined, fileName: entry.fileName ?? undefined, durationMs: entry.durationMs ?? undefined, proofCode: entry.proofCode ?? undefined });
    const { error } = await this.supabase.from("connect_switchboard").insert({
      id: itemId, organization_id: me.orgId, from_user: me.userId,
      conversation_id: site ? null : entry.conversationId, site_id: site,
      type: entry.kind, body, client_id: entry.id, attachment_path: path, mime_type: entry.mimeType, size_bytes: blob?.size ?? null,
    });
    if (error && !/duplicate/i.test(error.message)) return false;
    if (blob && path) {
      const { error: uploadError } = await this.supabase.storage.from("connect-temp").upload(path, blob, { contentType: blob.type || "application/octet-stream", upsert: true });
      if (uploadError) return false;
    }
    return true;
  }

  async messages(conversationId: string) {
    return this.me ? LocalStore.messages(this.me.userId, conversationId) : [];
  }

  async conversations() {
    return this.me ? LocalStore.conversations(this.me.userId) : [];
  }

  async blob(id: string) {
    return this.me ? LocalStore.getBlob(this.me.userId, id) : null;
  }
}

function mapRow(row: Record<string, unknown>): ConnectItem {
  return {
    id: String(row.id), fromUser: String(row.from_user), toUser: (row.to_user as string | null) ?? null,
    conversationId: (row.conversation_id as string | null) ?? null, siteId: (row.site_id as string | null) ?? null,
    type: row.type as ConnectItem["type"], body: (row.body as string | null) ?? null, refId: (row.ref_id as string | null) ?? null,
    clientId: (row.client_id as string | null) ?? null, attachmentPath: (row.attachment_path as string | null) ?? null,
    mimeType: (row.mime_type as string | null) ?? null, sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes), createdAt: String(row.created_at),
  };
}

export function preview(message: LocalMessage): string {
  switch (message.kind) {
    case "image": return "📷";
    case "camera_photo": return "📷 ✓";
    case "file": return `📎 ${message.fileName ?? ""}`;
    case "voice_note": return "🎤";
    case "push_to_talk": return "📻";
    case "missed": return "📞 ✕";
    case "meeting_invite": return "👥";
    case "photo_request": return "📷 ?";
    default: return (message.body ?? "").slice(0, 80);
  }
}

export const ConnectEngine = new Engine();
