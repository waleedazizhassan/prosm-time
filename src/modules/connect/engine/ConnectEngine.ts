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
/** the body of a message taken back by its sender (shown as "this message was deleted") */
export const DELETED = "§deleted";
export interface ConnectGroup { id: string; title: string; createdAt: string; members: { userId: string; role: "admin" | "member" }[] }
interface Retraction { from: string; conversationId: string | null; siteId: string | null; clientIds: string[]; createdAt?: string }

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
    this.subscribe(userId);
    window.addEventListener("online", this.onOnline);
    // owner 2026-11-15 ("a message arrives but only shows once I open the chat"): the moment the app is in front again,
    // read what came; and while the live channel is down, read every few seconds instead of every 30
    document.addEventListener("visibilitychange", this.onVisible);
    window.addEventListener("focus", this.onVisible);
    this.schedule();
    void this.drain();
    void this.flush();
  }

  /** true while the private live channel is joined; false makes the inbox the (faster) path */
  private live = false;

  private subscribe(userId: string) {
    const channel = this.supabase.channel(`connect:user:${userId}`, { config: { private: true } });
    channel
      .on("broadcast", { event: "item" }, (message) => void this.fetchAndHandle((message.payload as { id: string }).id))
      .on("broadcast", { event: "receipt" }, (message) => void this.handleReceipt(message.payload as Record<string, unknown>))
      .on("broadcast", { event: "call" }, (message) => this.emit("call-signal", message.payload))
      .on("broadcast", { event: "retract" }, (message) => void this.applyRetraction(message.payload as Retraction))
      .on("broadcast", { event: "typing" }, (message) => this.emit("typing", message.payload))
      .subscribe((status, error) => {
        if (status === "SUBSCRIBED") {
          this.live = true;
          this.schedule();
          void this.drain();
          return;
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          const wasLive = this.live;
          this.live = false;
          this.schedule();
          if (status !== "CLOSED" || wasLive) console.warn("[connect] live channel", status, error?.message ?? "");
          // join again with a fresh session, unless the engine was stopped
          if (status !== "CLOSED" && this.me?.userId === userId) {
            window.setTimeout(() => void this.rejoin(userId), 5000);
          }
        }
      });
    this.channel = channel;
  }

  private async rejoin(userId: string) {
    if (this.me?.userId !== userId || this.live) return;
    try {
      const session = (await this.supabase.auth.getSession()).data.session;
      if (session) await this.supabase.realtime.setAuth(session.access_token);
    } catch {
      // try with what the client has
    }
    if (this.channel) await this.supabase.removeChannel(this.channel).catch(() => undefined);
    this.subscribe(userId);
  }

  /** 30 s while the live channel brings everything, 5 s while it is down */
  private schedule() {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = window.setInterval(() => {
      void this.drain();
      void this.flush();
    }, this.live ? 30000 : 5000);
  }

  private onVisible = () => {
    if (document.visibilityState === "visible") {
      void this.drain();
      void this.flush();
    }
  };

  async stop() {
    if (this.channel) await this.supabase.removeChannel(this.channel).catch(() => undefined);
    this.channel = null;
    if (this.timer) window.clearInterval(this.timer);
    this.timer = null;
    window.removeEventListener("online", this.onOnline);
    document.removeEventListener("visibilitychange", this.onVisible);
    window.removeEventListener("focus", this.onVisible);
    this.live = false;
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
      await this.syncRetractions();
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
      refId: item.refId, replyTo: item.replyTo ?? null, replySnippet: item.replySnippet ?? null,
    };
    await LocalStore.putMessage(me.userId, message);
    const group = item.conversationId ? await this.groupOf(item.conversationId) : null;
    await this.touchConversation(conversationId, message, item.siteId ? "site" : group ? "group" : "direct", group ? null : item.fromUser, this.openConversation !== conversationId, group?.title ?? null);
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

  private async touchConversation(id: string, message: LocalMessage, kind: LocalConversation["kind"], otherUserId: string | null, countUnread: boolean, title: string | null = null) {
    const me = this.me!;
    const current = await LocalStore.getConversation(me.userId, id);
    await LocalStore.putConversation(me.userId, {
      id, kind: kind === "group" ? "group" : current?.kind ?? kind, otherUserId: kind === "group" ? null : current?.otherUserId ?? (kind === "direct" ? otherUserId : null), title: title ?? current?.title ?? null,
      lastAt: message.createdAt, lastPreview: preview(message), unread: (current?.unread ?? 0) + (countUnread && !message.mine ? 1 : 0),
    });
    this.emit("conversations");
  }

  // ---- sending --------------------------------------------------------------------------------------------------
  /** Writes the message on the device at once (🕓) and sends it when it can. */
  async send(conversationId: string, kind: MessageKind, input: { body?: string | null; blob?: Blob | null; fileName?: string | null; durationMs?: number | null; proofCode?: string | null; otherUserId?: string | null; replyTo?: string | null; replySnippet?: string | null }) {
    const me = this.me;
    if (!me) throw new Error("Connect is not started.");
    const id = uuid();
    const createdAt = new Date().toISOString();
    if (input.blob) await LocalStore.putBlob(me.userId, id, input.blob);
    const message: LocalMessage = {
      id, conversationId, fromUser: me.userId, kind, createdAt, status: "pending", mine: true,
      sizeBytes: input.blob?.size ?? (input.body ?? "").length, body: input.body ?? null, fileName: input.fileName ?? null,
      mimeType: input.blob?.type ?? null, durationMs: input.durationMs ?? null, proofCode: input.proofCode ?? null, hasBlob: Boolean(input.blob),
      replyTo: input.replyTo ?? null, replySnippet: input.replySnippet?.slice(0, 200) ?? null,
    };
    await LocalStore.putMessage(me.userId, message);
    const group = conversationId.startsWith("site:") ? null : await this.groupOf(conversationId);
    await this.touchConversation(conversationId, message, conversationId.startsWith("site:") ? "site" : group ? "group" : "direct", input.otherUserId ?? null, false, group?.title ?? null);
    const entry: OutboxEntry = { id, conversationId, kind, body: input.body ?? null, fileName: input.fileName ?? null, mimeType: input.blob?.type ?? null, durationMs: input.durationMs ?? null, proofCode: input.proofCode ?? null, createdAt, tries: 0, replyTo: message.replyTo, replySnippet: message.replySnippet };
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
    const row: Record<string, unknown> = {
      id: itemId, organization_id: me.orgId, from_user: me.userId,
      conversation_id: site ? null : entry.conversationId, site_id: site,
      type: entry.kind, body, client_id: entry.id, attachment_path: path, mime_type: entry.mimeType, size_bytes: blob?.size ?? null,
    };
    let { error } = await this.supabase.from("connect_switchboard").insert(entry.replyTo ? { ...row, reply_to: entry.replyTo, reply_snippet: entry.replySnippet ?? null } : row);
    // a server without the reply columns (20261116190000) still gets the message - without its quote
    if (error && entry.replyTo && /reply_(to|snippet)/i.test(error.message)) ({ error } = await this.supabase.from("connect_switchboard").insert(row));
    if (error && !/duplicate/i.test(error.message)) return false;
    if (blob && path) {
      const { error: uploadError } = await this.supabase.storage.from("connect-temp").upload(path, blob, { contentType: blob.type || "application/octet-stream", upsert: true });
      if (uploadError) return false;
    }
    return true;
  }

  // ---- groups (owner 2026-11-15 / 16) -------------------------------------------------------------------------
  private groups = new Map<string, ConnectGroup>();
  private groupsLoadedAt = 0;

  /** my groups (name, members, roles) - read again at most every 10 s, or when a group is unknown */
  async loadGroups(force = false): Promise<ConnectGroup[]> {
    if (!force && Date.now() - this.groupsLoadedAt < 10_000) return [...this.groups.values()];
    const { data, error } = await this.supabase.rpc("list_prosm_time_connect_groups");
    if (error || !Array.isArray(data)) return [...this.groups.values()];
    this.groups = new Map((data as ConnectGroup[]).map((g) => [g.id, g]));
    this.groupsLoadedAt = Date.now();
    return [...this.groups.values()];
  }

  async groupOf(conversationId: string): Promise<ConnectGroup | null> {
    if (!this.groups.has(conversationId)) await this.loadGroups();
    return this.groups.get(conversationId) ?? null;
  }

  groupNow(conversationId: string): ConnectGroup | null {
    return this.groups.get(conversationId) ?? null;
  }

  async createGroup(title: string, members: string[]): Promise<string | null> {
    const me = this.me;
    if (!me) return null;
    const { data, error } = await this.supabase.rpc("prosm_time_connect_create_group", { p_title: title, p_members: members });
    if (error || !data) return null;
    const id = String(data);
    await this.loadGroups(true);
    await LocalStore.putConversation(me.userId, { id, kind: "group", otherUserId: null, title, lastAt: new Date().toISOString(), lastPreview: "", unread: 0 });
    this.emit("conversations");
    return id;
  }

  async updateGroup(conversationId: string, change: { title?: string | null; add?: string[] | null; remove?: string[] | null }): Promise<boolean> {
    const { error } = await this.supabase.rpc("prosm_time_connect_update_group", { p_conversation: conversationId, p_title: change.title ?? null, p_add: change.add ?? null, p_remove: change.remove ?? null });
    if (error) return false;
    await this.loadGroups(true);
    const me = this.me;
    const current = me ? await LocalStore.getConversation(me.userId, conversationId) : null;
    if (me && current && change.title) await LocalStore.putConversation(me.userId, { ...current, title: change.title });
    this.emit("conversations");
    return true;
  }

  async leaveGroup(conversationId: string): Promise<boolean> {
    const { error } = await this.supabase.rpc("prosm_time_connect_leave_group", { p_conversation: conversationId });
    if (error) return false;
    await this.loadGroups(true);
    await this.deleteConversation(conversationId);
    return true;
  }

  /** owner 2026-11-16: "typing" - at most every 3 s per conversation; never stored */
  private typingSentAt = new Map<string, number>();
  typing(conversationId: string) {
    if (!this.me || conversationId.startsWith("site:")) return;
    const last = this.typingSentAt.get(conversationId) ?? 0;
    if (Date.now() - last < 3000) return;
    this.typingSentAt.set(conversationId, Date.now());
    void this.supabase.rpc("prosm_time_connect_typing", { p_conversation: conversationId }).then(() => undefined, () => undefined);
  }

  /** owner 2026-11-16: delete messages for me (this device) - the other side keeps theirs. */
  async deleteMessages(conversationId: string, ids: string[]) {
    const me = this.me;
    if (!me || ids.length === 0) return;
    await LocalStore.deleteMessages(me.userId, ids);
    // the conversation's last line follows what is left
    const left = await LocalStore.messages(me.userId, conversationId);
    const conversation = await LocalStore.getConversation(me.userId, conversationId);
    if (conversation) {
      const last = left[left.length - 1];
      await LocalStore.putConversation(me.userId, { ...conversation, lastPreview: last ? preview(last) : "", lastAt: last?.createdAt ?? conversation.lastAt });
    }
    this.emit("conversations");
  }

  /**
   * owner 2026-11-16: delete my own messages FOR EVERYONE. The server keeps a notice for the other devices (newer
   * apps act on it; older ones never see it) and drops copies not yet fetched; here the messages become
   * "this message was deleted".
   */
  async retractMessages(conversationId: string, ids: string[]): Promise<boolean> {
    const me = this.me;
    if (!me || ids.length === 0) return false;
    const site = conversationId.startsWith("site:") ? conversationId.slice(5) : null;
    const { error } = await this.supabase.rpc("prosm_time_connect_retract", { p_conversation: site ? null : conversationId, p_site: site, p_client_ids: ids });
    if (error) return false;
    for (const id of ids) await this.markDeleted(id, me.userId);
    this.emit("conversations");
    return true;
  }

  private async markDeleted(id: string, expectedSender: string): Promise<LocalMessage | null> {
    const me = this.me;
    if (!me) return null;
    const message = await LocalStore.getMessage(me.userId, id);
    // only the person who sent a message can take it back
    if (!message || message.fromUser !== expectedSender || message.body === DELETED) return null;
    const replaced: LocalMessage = { ...message, kind: "message", body: DELETED, fileName: null, mimeType: null, durationMs: null, proofCode: null, hasBlob: false, sizeBytes: 0 };
    await LocalStore.deleteMessages(me.userId, [id]);
    await LocalStore.putMessage(me.userId, replaced);
    const conversation = await LocalStore.getConversation(me.userId, message.conversationId);
    if (conversation && conversation.lastAt === message.createdAt) await LocalStore.putConversation(me.userId, { ...conversation, lastPreview: DELETED });
    return replaced;
  }

  private async applyRetraction(r: Retraction) {
    if (!this.me || !r?.from || !Array.isArray(r.clientIds)) return;
    let changed = false;
    for (const id of r.clientIds) {
      const replaced = await this.markDeleted(String(id), r.from);
      if (replaced) {
        changed = true;
        this.emit("message", replaced);
      }
    }
    if (changed) this.emit("conversations");
  }

  /** notices that came while this device was away (kept 14 days on the server) */
  private async syncRetractions() {
    const me = this.me;
    if (!me) return;
    const key = `prosm_connect_retract_since:${me.userId}`;
    let since: string | null = null;
    try { since = localStorage.getItem(key); } catch { since = null; }
    const { data, error } = await this.supabase.rpc("list_prosm_time_connect_retractions", { p_since: since });
    if (error || !Array.isArray(data)) return;
    for (const r of data as Retraction[]) {
      await this.applyRetraction(r);
      since = r.createdAt ?? since;
    }
    try { if (since) localStorage.setItem(key, since); } catch { /* the next pass reads again; applying twice changes nothing */ }
  }

  /** owner 2026-11-16: delete a whole conversation from this device. */
  async deleteConversation(conversationId: string) {
    const me = this.me;
    if (!me) return;
    await LocalStore.deleteConversation(me.userId, conversationId);
    this.emit("conversations");
  }

  /** owner 2026-11-16: remove calls from my call log (null = all); the organisation's record stays. */
  async hideCalls(callIds: string[] | null): Promise<boolean> {
    const { error } = await this.supabase.rpc("prosm_time_connect_hide_calls", { p_call_ids: callIds });
    return !error;
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
    replyTo: (row.reply_to as string | null) ?? null, replySnippet: (row.reply_snippet as string | null) ?? null,
  };
}

export function preview(message: LocalMessage): string {
  switch (message.kind) {
    // owner 2026-11-15: words, not bare emoji - shown translated by the list (previewText)
    case "image": return "§image";
    case "camera_photo": return "§camera_photo";
    case "file": return `§file ${message.fileName ?? ""}`.trim();
    case "voice_note": return "§voice_note";
    case "push_to_talk": return "§push_to_talk";
    case "missed": return "§missed";
    case "meeting_invite": return "§meeting_invite";
    case "photo_request": return "§photo_request";
    default: return (message.body ?? "").slice(0, 80);
  }
}

export const ConnectEngine = new Engine();
