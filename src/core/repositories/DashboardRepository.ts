import DatabaseManager from "../database/DatabaseManager";

const localDayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

// Owner 2026-10-20 ("the dashboard's numbers are not right - reprogram them"):
// every figure on the dashboard comes from one server read
// (get_prosm_time_dashboard_summary, 20261020250000) over the people the
// reader is responsible for, instead of a dozen reads counted in the app.
export interface DashboardSummary {
  team: number;
  present: number;
  onBreak: number;
  onLeave: number;
  absent: number;
  waiting: number;
  week: { day: string; minutes: number }[];
}

const RETRIES = 2;

class DashboardRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async getSummary(now: Date = new Date()): Promise<ServiceResult<DashboardSummary>> {
    // The week runs Sunday to Saturday (owner 2026-10-19), in the reader's own time zone.
    const sunday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    let lastError = "";
    // A phone on a weak network sometimes drops one request; try again before saying so.
    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
      try {
        const { data, error } = await this.client.rpc("get_prosm_time_dashboard_summary", { p_week_start: localDayKey(sunday), p_time_zone: timeZone });
        if (!error && data) return { success: true, message: null, data: data as DashboardSummary };
        lastError = error?.message ?? "No answer.";
      } catch (error) {
        lastError = error instanceof Error ? error.message : "Dashboard service unavailable.";
      }
      if (attempt < RETRIES) await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
    }
    return { success: false, message: lastError, data: null };
  }
}

export default new DashboardRepository();
