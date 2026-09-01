import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

export interface AppNotification {
  id: string;
  type: string;
  priority: "normal" | "high";
  title: string;
  body: string | null;
  readAt: string | null;
  createdAt: string;
}

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}
function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

interface NotificationRow {
  id: string;
  type: string;
  priority: "normal" | "high";
  title: string;
  body: string | null;
  read_at: string | null;
  created_at: string;
}

function mapRow(row: NotificationRow): AppNotification {
  return { id: row.id, type: row.type, priority: row.priority, title: row.title, body: row.body, readAt: row.read_at, createdAt: row.created_at };
}

// PROSM Time WP-13/§20 - real notification inbox. RLS scopes every
// row strictly to its own recipient (unlike attendance data, never
// org-wide visible to anyone else, including supervisors).
class NotificationRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async listRecent(limit = 20): Promise<ServiceResult<AppNotification[]>> {
    try {
      const { data, error } = await this.client.from("notifications").select("*").order("created_at", { ascending: false }).limit(limit);
      if (error) return createError(error.message);
      return createSuccess((data ?? []).map(mapRow));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Notification service unavailable.");
    }
  }

  async markRead(notificationId: string): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.rpc("mark_prosm_time_notification_read", { p_notification_id: notificationId });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to mark this notification as read.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Notification service unavailable.");
    }
  }
}

export default new NotificationRepository();
