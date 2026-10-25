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

// Weekdays as Postgres counts them: 0 = Sunday ... 6 = Saturday.
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface Holiday {
  id: string;
  siteId: string | null;
  siteName: string | null;
  name: string;
  startDate: string;
  endDate: string;
  isPaid: boolean;
}

export interface ScheduleException {
  id: string;
  siteId: string | null;
  siteName: string | null;
  shiftTemplateId: string | null;
  shiftTemplateName: string | null;
  userId: string | null;
  userName: string | null;
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  isDayOff: boolean;
  noDeduction: boolean;
  reason: string;
}

export interface WorkCalendar {
  restDays: Weekday[];
  weekStartDay: Weekday;
  timezone: string;
  sites: { id: string; name: string; restDays: Weekday[] | null }[];
  holidays: Holiday[];
  exceptions: ScheduleException[];
}

export interface HolidayInput {
  id: string | null;
  siteId: string | null;
  name: string;
  startDate: string;
  endDate: string;
  isPaid: boolean;
}

export interface ScheduleExceptionInput {
  id: string | null;
  siteId: string | null;
  shiftTemplateId: string | null;
  userId: string | null;
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  isDayOff: boolean;
  noDeduction: boolean;
  reason: string;
}

const hhmm = (value: unknown) => (typeof value === "string" ? value.slice(0, 5) : null);

// v2.3.43 step 3 (items 7 and 8): public holidays, weekly rest days and
// exceptional days. Every change is checked (calendar.manage, site scope)
// and audited on the server.
class CalendarRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async getCalendar(from: string, to: string): Promise<ServiceResult<WorkCalendar>> {
    try {
      const { data, error } = await this.client.rpc("get_prosm_time_calendar", { p_from: from, p_to: to });
      if (error) return createError(error.message);
      const raw = (data ?? {}) as Record<string, unknown>;
      const exceptions = ((raw.exceptions ?? []) as Record<string, unknown>[]).map((row) => ({
        ...(row as unknown as ScheduleException),
        startTime: hhmm(row.startTime),
        endTime: hhmm(row.endTime),
      }));
      return createSuccess({
        restDays: (raw.restDays ?? [5]) as Weekday[],
        weekStartDay: (raw.weekStartDay ?? 6) as Weekday,
        timezone: String(raw.timezone ?? "Africa/Cairo"),
        sites: (raw.sites ?? []) as WorkCalendar["sites"],
        holidays: (raw.holidays ?? []) as Holiday[],
        exceptions,
      });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Calendar service unavailable.");
    }
  }

  async saveHoliday(input: HolidayInput): Promise<ServiceResult> {
    try {
      const { error } = await this.client.rpc("save_prosm_time_holiday", {
        p_id: input.id,
        p_site_id: input.siteId,
        p_name: input.name,
        p_start_date: input.startDate,
        p_end_date: input.endDate,
        p_is_paid: input.isPaid,
      });
      if (error) return createError(error.message);
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Calendar service unavailable.");
    }
  }

  async deleteHoliday(id: string): Promise<ServiceResult> {
    try {
      const { error } = await this.client.rpc("delete_prosm_time_holiday", { p_id: id });
      if (error) return createError(error.message);
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Calendar service unavailable.");
    }
  }

  // siteId and shiftTemplateId null = the organisation's; days null = inherit.
  async setRestDays(siteId: string | null, shiftTemplateId: string | null, days: Weekday[] | null): Promise<ServiceResult> {
    try {
      const { error } = await this.client.rpc("set_prosm_time_rest_days", { p_site_id: siteId, p_shift_template_id: shiftTemplateId, p_days: days });
      if (error) return createError(error.message);
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Calendar service unavailable.");
    }
  }

  async saveException(input: ScheduleExceptionInput): Promise<ServiceResult> {
    try {
      const { error } = await this.client.rpc("save_prosm_time_schedule_exception", {
        p_id: input.id,
        p_site_id: input.siteId,
        p_shift_template_id: input.shiftTemplateId,
        p_user_id: input.userId,
        p_start_date: input.startDate,
        p_end_date: input.endDate,
        p_start_time: input.startTime,
        p_end_time: input.endTime,
        p_is_day_off: input.isDayOff,
        p_no_deduction: input.noDeduction,
        p_reason: input.reason,
      });
      if (error) return createError(error.message);
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Calendar service unavailable.");
    }
  }

  async deleteException(id: string): Promise<ServiceResult> {
    try {
      const { error } = await this.client.rpc("delete_prosm_time_schedule_exception", { p_id: id });
      if (error) return createError(error.message);
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Calendar service unavailable.");
    }
  }
}

export default new CalendarRepository();
