import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}

function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

export type PermissionKind = "late_arrival" | "early_leave" | "approved_overtime" | "no_overtime";
export type OvertimeApprovalMode = "automatic" | "approval";

// One work day as the server calculates it (prosm_time_day_summary).
export interface DaySummary {
  day: string;
  siteId: string | null;
  dayType: "workday" | "weekly_rest" | "public_holiday";
  workedMinutes: number;
  breakMinutes: number;
  overtimeMinutes: number;
  overtimeWeightedMinutes: number;
  nightOvertimeMinutes: number;
  overtimePendingApprovalMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  deductionMinutes: number;
  noDeduction: boolean;
  adjusted: boolean;
  permissions: { id: string; kind: PermissionKind; paid: boolean; minutes: number | null; reason: string }[];
}

export interface PermissionRequest {
  id: string;
  userId: string;
  employeeName: string;
  avatarUrl: string | null;
  workDate: string;
  kind: PermissionKind;
  minutes: number | null;
  reason: string;
  createdAt: string;
}

export interface OvertimeAwaiting extends DaySummary {
  userId: string;
  employeeName: string;
  avatarUrl: string | null;
}

export interface OvertimePolicy {
  approvalMode: OvertimeApprovalMode | null;
  minOvertimeMinutes: number | null;
  minLateMinutes: number | null;
  maxDailyOvertimeMinutes: number | null;
  multiplierNormal: number | null;
  multiplierNight: number | null;
  multiplierWeeklyRest: number | null;
  multiplierPublicHoliday: number | null;
  nightStart: string | null;
  nightEnd: string | null;
}

export const EMPTY_POLICY: OvertimePolicy = {
  approvalMode: null,
  minOvertimeMinutes: null,
  minLateMinutes: null,
  maxDailyOvertimeMinutes: null,
  multiplierNormal: null,
  multiplierNight: null,
  multiplierWeeklyRest: null,
  multiplierPublicHoliday: null,
  nightStart: null,
  nightEnd: null,
};

const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));

function toSummary(raw: Record<string, unknown>): DaySummary {
  return {
    day: String(raw.day),
    siteId: (raw.siteId as string | null) ?? null,
    dayType: (raw.dayType as DaySummary["dayType"]) ?? "workday",
    workedMinutes: Number(raw.workedMinutes ?? 0),
    breakMinutes: Number(raw.breakMinutes ?? 0),
    overtimeMinutes: Number(raw.overtimeMinutes ?? 0),
    overtimeWeightedMinutes: Number(raw.overtimeWeightedMinutes ?? 0),
    nightOvertimeMinutes: Number(raw.nightOvertimeMinutes ?? 0),
    overtimePendingApprovalMinutes: Number(raw.overtimePendingApprovalMinutes ?? 0),
    lateMinutes: Number(raw.lateMinutes ?? 0),
    earlyLeaveMinutes: Number(raw.earlyLeaveMinutes ?? 0),
    deductionMinutes: Number(raw.deductionMinutes ?? 0),
    noDeduction: Boolean(raw.noDeduction),
    adjusted: Boolean(raw.adjusted),
    permissions: (raw.permissions ?? []) as DaySummary["permissions"],
  };
}

// v2.3.43 step 6 (item 23): permissions, overtime approval, day adjustments
// and the overtime policy. Every check (attendance.manage_permissions, the
// manager's sites, an approved period) is on the server.
class AttendanceControlRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  private async call<T = null>(fn: string, args: Record<string, unknown>, map?: (data: unknown) => T): Promise<ServiceResult<T>> {
    try {
      const { data, error } = await this.client.rpc(fn, args);
      if (error) return createError(error.message);
      return createSuccess(map ? map(data) : null);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Attendance service unavailable.");
    }
  }

  queue(): Promise<ServiceResult<{ requests: PermissionRequest[]; overtime: OvertimeAwaiting[] }>> {
    return this.call("list_prosm_time_permission_queue", {}, (data) => {
      const raw = (data ?? {}) as { requests?: PermissionRequest[]; overtime?: Record<string, unknown>[] };
      return {
        requests: raw.requests ?? [],
        overtime: (raw.overtime ?? []).map((row) => ({
          ...toSummary(row),
          userId: String(row.userId),
          employeeName: String(row.employeeName ?? ""),
          avatarUrl: (row.avatarUrl as string | null) ?? null,
        })),
      };
    });
  }

  daySummaries(userId: string, from: string, to: string): Promise<ServiceResult<DaySummary[]>> {
    return this.call("get_prosm_time_day_summaries", { p_user_id: userId, p_from: from, p_to: to }, (data) => ((data ?? []) as Record<string, unknown>[]).map(toSummary));
  }

  request(workDate: string, kind: PermissionKind, minutes: number | null, reason: string): Promise<ServiceResult> {
    return this.call("request_prosm_time_attendance_permission", { p_work_date: workDate, p_kind: kind, p_minutes: minutes, p_reason: reason });
  }

  cancel(id: string): Promise<ServiceResult> {
    return this.call("cancel_prosm_time_attendance_permission", { p_id: id });
  }

  review(id: string, action: "approved" | "rejected", paid: boolean, deductionPercent: number | null, deductionMinutes: number | null, notes: string): Promise<ServiceResult> {
    return this.call("review_prosm_time_attendance_permission", {
      p_id: id,
      p_action: action,
      p_paid: paid,
      p_deduction_percent: deductionPercent,
      p_deduction_minutes: deductionMinutes,
      p_notes: notes || null,
    });
  }

  grant(
    userId: string,
    workDate: string,
    kind: PermissionKind,
    minutes: number | null,
    paid: boolean,
    deductionPercent: number | null,
    deductionMinutes: number | null,
    reason: string,
  ): Promise<ServiceResult> {
    return this.call("grant_prosm_time_attendance_permission", {
      p_user_id: userId,
      p_work_date: workDate,
      p_kind: kind,
      p_minutes: minutes,
      p_paid: paid,
      p_deduction_percent: deductionPercent,
      p_deduction_minutes: deductionMinutes,
      p_reason: reason,
    });
  }

  // null = leave that part as calculated.
  adjustDay(
    userId: string,
    workDate: string,
    change: { overtimeMinutes?: number | null; lateMinutes?: number | null; deductionMinutes?: number | null; overtimeApproved?: boolean | null },
    reason: string,
  ): Promise<ServiceResult> {
    return this.call("adjust_prosm_time_attendance_day", {
      p_user_id: userId,
      p_work_date: workDate,
      p_overtime_minutes: change.overtimeMinutes ?? null,
      p_late_minutes: change.lateMinutes ?? null,
      p_deduction_minutes: change.deductionMinutes ?? null,
      p_overtime_approved: change.overtimeApproved ?? null,
      p_reason: reason,
    });
  }

  // The organisation's policy row (site and template null).
  async getOrganizationPolicy(): Promise<ServiceResult<OvertimePolicy>> {
    try {
      const { data, error } = await this.client.from("overtime_policies").select("*").is("site_id", null).is("shift_template_id", null).maybeSingle();
      if (error) return createError(error.message);
      if (!data) return createSuccess({ ...EMPTY_POLICY });
      return createSuccess({
        approvalMode: data.approval_mode,
        minOvertimeMinutes: num(data.min_overtime_minutes),
        minLateMinutes: num(data.min_late_minutes),
        maxDailyOvertimeMinutes: num(data.max_daily_overtime_minutes),
        multiplierNormal: num(data.multiplier_normal),
        multiplierNight: num(data.multiplier_night),
        multiplierWeeklyRest: num(data.multiplier_weekly_rest),
        multiplierPublicHoliday: num(data.multiplier_public_holiday),
        nightStart: data.night_start ? String(data.night_start).slice(0, 5) : null,
        nightEnd: data.night_end ? String(data.night_end).slice(0, 5) : null,
      });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Attendance service unavailable.");
    }
  }

  setPolicy(siteId: string | null, shiftTemplateId: string | null, policy: OvertimePolicy): Promise<ServiceResult> {
    return this.call("set_prosm_time_overtime_policy", { p_site_id: siteId, p_shift_template_id: shiftTemplateId, p_policy: policy });
  }

  setBreakRules(shiftTemplateId: string, paid: boolean, maxMinutes: number | null, autoDeductMinutes: number | null): Promise<ServiceResult> {
    return this.call("set_prosm_time_shift_break_rules", { p_shift_template_id: shiftTemplateId, p_paid: paid, p_max_minutes: maxMinutes, p_auto_deduct_minutes: autoDeductMinutes });
  }
}

export default new AttendanceControlRepository();
