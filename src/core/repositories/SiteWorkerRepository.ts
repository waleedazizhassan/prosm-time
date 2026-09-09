import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

export interface SiteWorker {
  id: string;
  fullName: string;
  workerNumber: string;
  status: "active" | "inactive";
  createdAt: string;
}

export interface SiteWorkerAttendanceRow {
  id: string;
  workerName: string;
  workerNumber: string;
  siteName: string;
  clockInAt: string;
  clockOutAt: string | null;
}

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}
function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

// PROSM Time - § user-directed: external/contractor workforce
// (عمالة خارجية) tracked via Kiosk mode, genuinely separate from
// "employees" - a site manager/Owner adds each worker and assigns a
// single 6-digit number, which alone is both identity and kiosk
// credential. See 20260910100000's own header comment for the full
// design reasoning, including why this is deliberately NOT modeled on
// the users/attendance_sessions tables.
class SiteWorkerRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async list(siteId: string): Promise<ServiceResult<SiteWorker[]>> {
    try {
      const { data, error } = await this.client.rpc("list_prosm_time_site_workers", { p_site_id: siteId });
      if (error) return createError(error.message);
      return createSuccess(
        (data ?? []).map((row: { id: string; full_name: string; worker_number: string; status: "active" | "inactive"; created_at: string }) => ({
          id: row.id,
          fullName: row.full_name,
          workerNumber: row.worker_number,
          status: row.status,
          createdAt: row.created_at,
        })),
      );
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Workforce service unavailable.");
    }
  }

  async create(siteId: string, fullName: string, workerNumber: string): Promise<ServiceResult<{ workerId: string }>> {
    try {
      const { data, error } = await this.client.rpc("create_prosm_time_site_worker", { p_site_id: siteId, p_full_name: fullName, p_worker_number: workerNumber });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to add this worker.");
      return createSuccess({ workerId: data.workerId });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Workforce service unavailable.");
    }
  }

  async deactivate(workerId: string): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.rpc("deactivate_prosm_time_site_worker", { p_worker_id: workerId });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to deactivate this worker.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Workforce service unavailable.");
    }
  }

  async listAttendance(siteId: string | null, startDate: string | null, endDate: string | null): Promise<ServiceResult<SiteWorkerAttendanceRow[]>> {
    try {
      const { data, error } = await this.client.rpc("list_prosm_time_site_worker_attendance", { p_site_id: siteId, p_start_date: startDate, p_end_date: endDate });
      if (error) return createError(error.message);
      return createSuccess(
        (data ?? []).map((row: { id: string; worker_name: string; worker_number: string; site_name: string; clock_in_at: string; clock_out_at: string | null }) => ({
          id: row.id,
          workerName: row.worker_name,
          workerNumber: row.worker_number,
          siteName: row.site_name,
          clockInAt: row.clock_in_at,
          clockOutAt: row.clock_out_at,
        })),
      );
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Workforce service unavailable.");
    }
  }

  async kioskClockIn(siteId: string, workerNumber: string, latitude: number, longitude: number): Promise<ServiceResult<{ entryId: string; workerName: string }>> {
    try {
      const { data, error } = await this.client.functions.invoke("kiosk-worker-clock-in", { body: { siteId, workerNumber, latitude, longitude } });
      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to clock in.");
      }
      if (data?.success === false) return createError(data?.error?.message ?? "Unable to clock in.");
      return createSuccess({ entryId: data.data.entryId, workerName: data.data.workerName });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Kiosk service unavailable.");
    }
  }

  async kioskClockOut(siteId: string, workerNumber: string, latitude: number, longitude: number): Promise<ServiceResult<{ entryId: string; workerName: string }>> {
    try {
      const { data, error } = await this.client.functions.invoke("kiosk-worker-clock-out", { body: { siteId, workerNumber, latitude, longitude } });
      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to clock out.");
      }
      if (data?.success === false) return createError(data?.error?.message ?? "Unable to clock out.");
      return createSuccess({ entryId: data.data.entryId, workerName: data.data.workerName });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Kiosk service unavailable.");
    }
  }
}

export default new SiteWorkerRepository();
