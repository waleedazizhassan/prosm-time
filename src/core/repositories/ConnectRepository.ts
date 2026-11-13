import DatabaseManager from "../database/DatabaseManager";

// PROSM Connect (owner 2026-11-13) - the app's side of the switchboard (001). The server carries a request to
// the right person and lets go of it once received; the content itself is kept on each person's device.
// Every call is checked again on the server (plan, organisation, the sender is the signed-in person).

export interface ConnectFeatures {
  enabled: boolean;
  chat: boolean;
  cameraPhoto: boolean;
  calls: boolean;
  siteBroadcast: boolean;
  pushToTalk: boolean;
  meetings: boolean;
  screenShare: boolean;
  meetingRecording: boolean;
  maxFileMb: number;
  myExtension: string | null;
}

export type ConnectItemType =
  | "message" | "image" | "camera_photo" | "file" | "voice_note" | "push_to_talk"
  | "site_broadcast" | "photo_request"
  | "audio_call" | "video_call" | "meeting_invite"
  | "accept" | "reject" | "busy" | "end" | "missed";

export interface ConnectItem {
  id: string;
  fromUser: string;
  toUser: string | null;
  conversationId: string | null;
  siteId: string | null;
  type: ConnectItemType;
  body: string | null;
  refId: string | null;
  clientId: string | null;
  attachmentPath: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  createdAt: string;
}

/** A colleague as Connect shows them (any member may read this short list while the module is on). */
export interface ConnectPerson {
  id: string;
  fullName: string;
  avatarUrl: string | null;
  roleKey: string;
  roleName: string;
  isOwner: boolean;
  isActive: boolean;
  ext: string | null;
  presence: "in" | "break" | "out" | "leave";
  clockInAt: string | null;
  currentSiteName: string | null;
  siteNames: string[];
}

export interface ConnectExtension {
  userId: string;
  ext: string;
}

const NONE: ConnectFeatures = {
  enabled: false, chat: false, cameraPhoto: false, calls: false, siteBroadcast: false, pushToTalk: false,
  meetings: false, screenShare: false, meetingRecording: false, maxFileMb: 100, myExtension: null,
};

function mapItem(row: Record<string, unknown>): ConnectItem {
  return {
    id: String(row.id),
    fromUser: String(row.from_user),
    toUser: (row.to_user as string | null) ?? null,
    conversationId: (row.conversation_id as string | null) ?? null,
    siteId: (row.site_id as string | null) ?? null,
    type: row.type as ConnectItemType,
    body: (row.body as string | null) ?? null,
    refId: (row.ref_id as string | null) ?? null,
    clientId: (row.client_id as string | null) ?? null,
    attachmentPath: (row.attachment_path as string | null) ?? null,
    mimeType: (row.mime_type as string | null) ?? null,
    sizeBytes: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
    createdAt: String(row.created_at),
  };
}

class ConnectRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  /** What the organisation has of Connect; nothing when it cannot be read (the server refuses the rest anyway). */
  async features(): Promise<ConnectFeatures> {
    try {
      const { data, error } = await this.client.rpc("get_prosm_time_connect_features");
      if (error || !data) return NONE;
      return { ...NONE, ...(data as Partial<ConnectFeatures>) };
    } catch {
      return NONE;
    }
  }

  /** The organisation's internal numbers (001 is the switchboard's). */
  async extensions(): Promise<ConnectExtension[]> {
    try {
      const { data, error } = await this.client.from("connect_extensions").select("user_id, ext");
      if (error) return [];
      return (data ?? []).map((row) => ({ userId: row.user_id as string, ext: row.ext as string }));
    } catch {
      return [];
    }
  }

  /** Everyone in the organisation with their number and attendance status. */
  async people(): Promise<ConnectPerson[]> {
    try {
      const { data, error } = await this.client.rpc("list_prosm_time_connect_people");
      if (error || !Array.isArray(data)) return [];
      return (data as ConnectPerson[]).map((p) => ({ ...p, isActive: true, siteNames: p.siteNames ?? [] }));
    } catch {
      return [];
    }
  }

  /** The direct conversation with someone (made the first time). */
  async openDirect(otherUserId: string): Promise<{ id: string | null; error: string | null }> {
    try {
      const { data, error } = await this.client.rpc("prosm_time_connect_open_direct", { p_other: otherUserId });
      if (error) return { id: null, error: error.message };
      return { id: data as string, error: null };
    } catch (error) {
      return { id: null, error: error instanceof Error ? error.message : "Connect unavailable." };
    }
  }

  /** Requests waiting for me (what Realtime or a push did not bring while I was away). */
  async inbox(): Promise<ConnectItem[]> {
    try {
      const { data, error } = await this.client.rpc("list_prosm_time_connect_inbox", { p_limit: 200 });
      if (error) return [];
      return ((data ?? []) as Record<string, unknown>[]).map(mapItem);
    } catch {
      return [];
    }
  }

  /** "Received" - once everyone has it, the server lets it go. */
  async ack(itemId: string): Promise<boolean> {
    try {
      const { data, error } = await this.client.rpc("prosm_time_connect_ack", { p_item_id: itemId });
      return !error && data === true;
    } catch {
      return false;
    }
  }
}

export default new ConnectRepository();
