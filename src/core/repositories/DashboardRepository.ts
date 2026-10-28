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

export type DashboardScope = "org" | "mine" | "me";
export type PresenceState = "in" | "break" | "outside" | "long";

export interface DashboardSos {
  id: string;
  userId: string;
  name: string;
  siteName: string | null;
  triggeredAt: string;
  latitude: number | null;
  longitude: number | null;
}

export interface DashboardPresent {
  userId: string;
  name: string;
  avatarUrl: string | null;
  clockInAt: string;
  siteId: string | null;
  siteName: string | null;
  status: PresenceState;
  latitude: number | null;
  longitude: number | null;
  lastLatitude: number | null;
  lastLongitude: number | null;
  timezone: string;
}

export interface DashboardSite {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radius: number;
  present: number;
  expected: number;
  late: number;
  absent: number;
  workedMinutes: number;
  overtimeMinutes: number;
  sos: boolean;
  outside: number;
  cost: number | null;
  external: { presentNow: number; today: number; minutesToday: number; contractors: { name: string; present: number; today: number }[] } | null;
}

// owner 2026-10-26: the sheet behind the absent-today card - each person
// absent today (no attendance, no approved leave) and each on leave
export interface DashboardAbsence {
  userId: string;
  name: string;
  avatarUrl: string | null;
  state: "absent" | "leave";
  siteName: string | null;
  shiftStart: string | null;
  leaveType: string | null;
  leaveTypeName: string | null;
  leaveEnd: string | null;
}

// owner 2026-10-27: the people behind the hours, late and overtime cards (the period)
export interface DashboardPersonFigures {
  userId: string;
  name: string;
  avatarUrl: string | null;
  siteName: string | null;
  days: number;
  workedMinutes: number;
  overtimeMinutes: number;
  overtimePendingMinutes: number;
  lateDays: number;
  lateMinutes: number;
  lateTodayMinutes: number | null;
  firstInToday: string | null;
  pendingMinutes: number;
}

export interface DashboardKpi {
  presentNow: number;
  expectedToday: number;
  hasSchedule: boolean;
  onLeaveToday: number;
  lateToday: number;
  absentToday: number;
  workedMinutes: number;
  scheduledMinutes: number;
  overtimeMinutes: number;
  lateCount: number;
  pendingMinutes: number;
  previous: { workedMinutes: number; overtimeMinutes: number; lateCount: number } | null;
  estimatedCost: number | null;
}

export interface DashboardChartDay {
  day: string;
  workedMinutes: number;
  scheduledMinutes: number;
  pendingMinutes: number;
  late: number;
  absent: number;
}

export interface DashboardAuditRow {
  id: string;
  created_at: string;
  action: string;
  reason: string | null;
  description: string | null;
  actor_name: string | null;
  subject_name: string | null;
  subject_id: string | null;
  site_id: string | null;
  device: string | null;
}

export interface ManagerDashboard {
  asOf: string;
  scope: DashboardScope;
  canViewCost: boolean;
  canViewExternal: boolean;
  canViewAudit: boolean;
  teamSize: number;
  sos: DashboardSos[];
  priorities: Record<string, number>;
  kpi: DashboardKpi;
  presentNow: DashboardPresent[];
  sites: DashboardSite[];
  chart: DashboardChartDay[];
  chartMonthly: { month: string; workedMinutes: number; overtimeMinutes: number; late: number }[];
  allowances: { total: number; overtimeAmount: number; overtimeMinutes: number; deductions: number } | null;
  audit: DashboardAuditRow[] | null;
  holidays: { name: string; startDate: string; endDate: string }[];
  absence?: DashboardAbsence[];
  byPerson?: DashboardPersonFigures[];
  // owner 2026-10-27: still clocked in an hour or more after their shift ended
  overdue?: { userId: string; name: string; avatarUrl: string | null; siteName: string | null; clockInAt: string; endedAt: string; overdueMinutes: number }[];
}

const RETRIES = 2;

export interface AuditLogQuery {
  from: string | null;
  to: string | null;
  userId: string | null;
  pattern: string | null;
  before: string | null;
  limit: number;
}

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

  // v2.3.43 step 17 (items 5, 4): the full manager dashboard in one read
  // (scoped; cost and external workers only with their permissions - all
  // decided on the server).
  /** Owner 2026-10-28: the action log's own page, newest first, a page at a time. */
  async listAuditLog(query: AuditLogQuery): Promise<ServiceResult<DashboardAuditRow[]>> {
    try {
      const { data, error } = await this.client.rpc("list_prosm_time_audit_log", {
        p_from: query.from,
        p_to: query.to,
        p_user_id: query.userId,
        p_action_pattern: query.pattern,
        p_before: query.before,
        p_limit: query.limit,
      });
      if (error) return { success: false, message: error.message, data: null };
      return { success: true, message: null, data: Array.isArray(data) ? (data as DashboardAuditRow[]) : [] };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : "Dashboard service unavailable.", data: null };
    }
  }

  async load(from: string, to: string, scope: DashboardScope, siteId: string | null): Promise<ServiceResult<ManagerDashboard>> {
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Africa/Cairo";
      const { data, error } = await this.client.rpc("get_prosm_time_manager_dashboard", {
        p_from: from,
        p_to: to,
        p_scope: scope,
        p_site_id: siteId,
        p_time_zone: timeZone,
      });
      if (error) return { success: false, message: error.message, data: null };
      return { success: true, message: null, data: data as ManagerDashboard };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : "Dashboard unavailable.", data: null };
    }
  }

  async loadLayout(): Promise<{ hidden: string[]; order: string[]; v?: number } | null> {
    try {
      const { data } = await this.client.from("dashboard_preferences").select("layout").maybeSingle();
      const layout = (data?.layout ?? null) as { hidden?: string[]; order?: string[] } | null;
      return layout ? { hidden: layout.hidden ?? [], order: layout.order ?? [] } : null;
    } catch {
      return null;
    }
  }

  async saveLayout(layout: { hidden: string[]; order: string[]; v?: number }): Promise<void> {
    try {
      await this.client.rpc("save_prosm_time_dashboard_layout", { p_layout: layout });
    } catch {
      // the local copy still applies on this device
    }
  }

  async acknowledgeSos(id: string, notes: string): Promise<ServiceResult<null>> {
    try {
      const { error } = await this.client.rpc("resolve_prosm_time_sos_alert", { p_sos_alert_id: id, p_resolution_notes: notes || null });
      return error ? { success: false, message: error.message, data: null } : { success: true, message: null, data: null };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : "SOS service unavailable.", data: null };
    }
  }
}

export default new DashboardRepository();
