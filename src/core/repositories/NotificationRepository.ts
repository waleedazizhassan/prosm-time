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
  // § live UX review, user-directed - "notifications need to be
  // translated." Structured params (employee name, distance, which
  // sub-case a shared type represents, a manager's decision) the
  // frontend renders through i18n - title/body above stay the raw
  // English fallback for any type this client doesn't recognize.
  data: Record<string, unknown>;
  // § live UX review, user-directed - "clicking a notification should
  // take me to the thing it's about." Already stored on every real
  // notification (create_prosm_time_notification's own
  // p_related_entity_type/p_related_entity_id), just never surfaced to
  // the frontend until now.
  relatedEntityType: string | null;
  relatedEntityId: string | null;
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
  data: Record<string, unknown> | null;
  related_entity_type: string | null;
  related_entity_id: string | null;
  read_at: string | null;
  created_at: string;
}

function mapRow(row: NotificationRow): AppNotification {
  return {
    id: row.id,
    type: row.type,
    priority: row.priority,
    title: row.title,
    body: row.body,
    data: row.data ?? {},
    relatedEntityType: row.related_entity_type,
    relatedEntityId: row.related_entity_id,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
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
