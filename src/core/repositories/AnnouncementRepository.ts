import DatabaseManager from "../database/DatabaseManager";

// 2026-11-09 Media Center: announcements and departments. Every check (organisation, permission,
// audience, who may open a file) is on the server; this only calls it.

type Result<T> = { data: T | null; error: string | null };

export type AnnouncementKind = "announcement" | "statement";
export type AudienceType = "all" | "sites" | "departments" | "people";
export type AnnouncementStatus = "draft" | "scheduled" | "published" | "expired" | "withdrawn";

export interface AnnouncementAttachment {
  id: string;
  kind: "link" | "file";
  title: string;
  url: string | null;
  fileName: string | null;
  mimeType: string | null;
  fileSize: number | null;
}

export interface MyAnnouncement {
  id: string;
  kind: AnnouncementKind;
  title: string;
  body: string;
  requiresAck: boolean;
  publishedAt: string;
  expiresAt: string | null;
  author: string | null;
  viewedAt: string | null;
  acknowledgedAt: string | null;
  attachments: AnnouncementAttachment[];
}

export interface AnnouncementDetail extends MyAnnouncement {
  status: AnnouncementStatus;
  audienceType: AudienceType;
  audienceIds: string[];
  sendEmail: boolean;
  publishAt: string | null;
  withdrawnReason: string | null;
}

export interface AnnouncementRow {
  id: string;
  kind: AnnouncementKind;
  title: string;
  status: AnnouncementStatus;
  audienceType: AudienceType;
  audienceCount: number;
  requiresAck: boolean;
  sendEmail: boolean;
  publishAt: string | null;
  publishedAt: string | null;
  expiresAt: string | null;
  author: string | null;
  mine: boolean;
  recipients: number;
  viewed: number;
  acknowledged: number;
}

export interface AnnouncementRead {
  userId: string;
  name: string;
  department: string | null;
  viewedAt: string | null;
  acknowledgedAt: string | null;
  emailStatus: "none" | "pending" | "sending" | "sent" | "failed";
}

export interface Department {
  id: string;
  name: string;
  isActive: boolean;
  members: number;
}

export interface AnnouncementInput {
  kind: AnnouncementKind;
  title: string;
  body: string;
  audienceType: AudienceType;
  audienceIds: string[];
  requiresAck: boolean;
  sendEmail: boolean;
  expiresAt: string | null;
}

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const ACCEPTED_FILES = "image/png,image/jpeg,image/webp,image/gif,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt";

const toBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

const MIME_BY_EXT: Record<string, string> = {
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv",
  txt: "text/plain",
  pdf: "application/pdf",
};

class AnnouncementRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  private async call<T>(fn: string, args: Record<string, unknown> = {}): Promise<Result<T>> {
    try {
      const { data, error } = await this.client.rpc(fn, args);
      if (error) return { data: null, error: error.message };
      return { data: data as T, error: null };
    } catch (error) {
      return { data: null, error: error instanceof Error ? error.message : "Announcements service unavailable." };
    }
  }

  private async media<T>(body: Record<string, unknown>): Promise<Result<T>> {
    try {
      const { data, error } = await this.client.functions.invoke("announcement-media", { body });
      if (error) {
        const errorBody = await (error as { context?: { json?: () => Promise<{ error?: { message?: string } }> } }).context?.json?.().catch(() => null);
        return { data: null, error: errorBody?.error?.message ?? error.message };
      }
      if (data?.success === false) return { data: null, error: data?.error?.message ?? "failed" };
      return { data: (data?.data ?? data) as T, error: null };
    } catch (error) {
      return { data: null, error: error instanceof Error ? error.message : "Announcements service unavailable." };
    }
  }

  mine() {
    return this.call<{ unread: number; items: MyAnnouncement[] }>("list_my_prosm_time_announcements");
  }

  markRead(id: string, acknowledge: boolean) {
    return this.call("mark_prosm_time_announcement_read", { p_id: id, p_acknowledge: acknowledge });
  }

  listManaged() {
    return this.call<AnnouncementRow[]>("list_prosm_time_announcements_admin");
  }

  get(id: string) {
    return this.call<AnnouncementDetail>("get_prosm_time_announcement", { p_id: id });
  }

  save(id: string | null, input: AnnouncementInput) {
    return this.call<{ id: string }>("save_prosm_time_announcement", { p_id: id, p_data: input });
  }

  publish(id: string, publishAt: string | null) {
    return this.call<{ status: AnnouncementStatus; recipients?: number }>("publish_prosm_time_announcement", { p_id: id, p_publish_at: publishAt });
  }

  withdraw(id: string, reason: string) {
    return this.call<{ status: AnnouncementStatus }>("withdraw_prosm_time_announcement", { p_id: id, p_reason: reason });
  }

  async remove(id: string, attachments: AnnouncementAttachment[]) {
    for (const file of attachments.filter((a) => a.kind === "file")) {
      const removed = await this.removeAttachment(file.id);
      if (removed.error) return removed;
    }
    return this.call("delete_prosm_time_announcement", { p_id: id });
  }

  reads(id: string) {
    return this.call<AnnouncementRead[]>("get_prosm_time_announcement_reads", { p_id: id });
  }

  addLink(id: string, url: string, title: string) {
    return this.call<{ id: string }>("add_prosm_time_announcement_link", { p_id: id, p_url: url, p_title: title });
  }

  async uploadFile(id: string, file: File) {
    if (file.size > MAX_FILE_BYTES) return { data: null, error: "THE FILE IS LARGER THAN 10 MB" };
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    const mimeType = file.type || MIME_BY_EXT[ext] || "application/octet-stream";
    const fileBase64 = await toBase64(file);
    return this.media<{ id: string }>({ action: "upload", announcementId: id, fileName: file.name, mimeType, fileBase64, title: file.name });
  }

  removeAttachment(attachmentId: string) {
    return this.media<{ removed: boolean }>({ action: "remove", attachmentId });
  }

  fileUrl(attachmentId: string, download = false) {
    return this.media<{ url: string; fileName: string; mimeType: string }>({ action: "url", attachmentId, download });
  }

  departments() {
    return this.call<Department[]>("list_prosm_time_departments");
  }

  saveDepartment(id: string | null, name: string, isActive = true) {
    return this.call<{ id: string }>("save_prosm_time_department", { p_id: id, p_name: name, p_is_active: isActive });
  }

  userDepartment(userId: string) {
    return this.call<{ departmentId: string | null; name: string | null }>("get_prosm_time_user_department", { p_user_id: userId });
  }

  setUserDepartment(userId: string, departmentId: string | null) {
    return this.call("set_prosm_time_user_department", { p_user_id: userId, p_department_id: departmentId });
  }
}

export default new AnnouncementRepository();
