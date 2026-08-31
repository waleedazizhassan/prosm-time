import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

export interface GeofenceException {
  id: string;
  distanceMeters: number;
  status: "pending_reason" | "pending_review" | "resolved";
}

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}
function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

interface GeofenceExceptionRow {
  id: string;
  distance_meters: number;
  status: "pending_reason" | "pending_review" | "resolved";
}

// PROSM Time WP-11/§19 - the employee's own pending out-of-zone
// exceptions, needing a reason before entering the manager review
// queue. Manager review UI itself belongs to WP-14's Manager Console
// (not yet built) - review_prosm_time_exception is already real and
// tested, just not consumed by any screen yet.
class ExceptionRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async listPendingReasonExceptions(userId: string): Promise<ServiceResult<GeofenceException[]>> {
    try {
      const { data, error } = await this.client.from("geofence_exceptions").select("id, distance_meters, status").eq("user_id", userId).eq("status", "pending_reason").order("created_at", { ascending: false });
      if (error) return createError(error.message);
      return createSuccess((data ?? []).map((row: GeofenceExceptionRow) => ({ id: row.id, distanceMeters: row.distance_meters, status: row.status })));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Exception service unavailable.");
    }
  }

  async submitReason(exceptionId: string, reasonCategory: string, reason: string): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.functions.invoke("submit-exception-reason", {
        body: { exceptionId, reasonCategory, reason },
      });
      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to submit this reason.");
      }
      if (data?.success === false) return createError(data?.error?.message ?? "Unable to submit this reason.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Exception service unavailable.");
    }
  }
}

export default new ExceptionRepository();
