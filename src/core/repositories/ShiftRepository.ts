import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

export interface ShiftTemplate {
  id: string;
  siteId: string;
  siteName: string | null;
  name: string;
  startTime: string;
  endTime: string;
  color: string | null;
}

export interface MyShiftRow {
  id: string;
  siteName: string;
  shiftDate: string;
  startTime: string;
  endTime: string;
  status: "scheduled" | "cancelled";
  notes: string | null;
  cancelledReason: string | null;
}

export interface SiteShiftRow {
  id: string;
  userId: string;
  employeeName: string;
  shiftDate: string;
  startTime: string;
  endTime: string;
  status: "scheduled" | "cancelled";
  notes: string | null;
  cancelledReason: string | null;
}

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}
function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

interface ShiftTemplateRowRaw {
  id: string;
  site_id: string;
  name: string;
  start_time: string;
  end_time: string;
  color: string | null;
  sites: { name: string } | { name: string }[] | null;
}

function mapTemplateRow(row: ShiftTemplateRowRaw): ShiftTemplate {
  const site = Array.isArray(row.sites) ? row.sites[0] : row.sites;
  return { id: row.id, siteId: row.site_id, siteName: site?.name ?? null, name: row.name, startTime: row.start_time, endTime: row.end_time, color: row.color };
}

interface MyShiftRowRaw {
  id: string;
  shift_date: string;
  start_time: string;
  end_time: string;
  status: "scheduled" | "cancelled";
  notes: string | null;
  cancelled_reason: string | null;
  sites: { name: string } | { name: string }[] | null;
}

function mapMyShiftRow(row: MyShiftRowRaw): MyShiftRow {
  const site = Array.isArray(row.sites) ? row.sites[0] : row.sites;
  return {
    id: row.id,
    siteName: site?.name ?? "",
    shiftDate: row.shift_date,
    startTime: row.start_time,
    endTime: row.end_time,
    status: row.status,
    notes: row.notes,
    cancelledReason: row.cancelled_reason,
  };
}

// PROSM Time - § user-directed: real advance shift scheduling/
// rostering, the last of the 3 competitive gaps this session's own
// research found. shift_templates are a reusable named time pattern
// per site; shift_assignments are a specific employee scheduled on a
// specific date (schedules.manage/Owner only - the permission already
// existed, unused, since Phase 1).
class ShiftRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async listTemplates(siteId?: string): Promise<ServiceResult<ShiftTemplate[]>> {
    try {
      let query = this.client.from("shift_templates").select("id, site_id, name, start_time, end_time, color, sites(name)").order("name", { ascending: true });
      if (siteId) query = query.eq("site_id", siteId);
      const { data, error } = await query;
      if (error) return createError(error.message);
      return createSuccess((data ?? []).map(mapTemplateRow));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Schedule service unavailable.");
    }
  }

  async createTemplate(siteId: string, name: string, startTime: string, endTime: string, color?: string): Promise<ServiceResult<{ templateId: string }>> {
    try {
      const { data, error } = await this.client.rpc("create_prosm_time_shift_template", {
        p_site_id: siteId,
        p_name: name,
        p_start_time: startTime,
        p_end_time: endTime,
        p_color: color ?? null,
      });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to create this shift template.");
      return createSuccess({ templateId: data.templateId });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Schedule service unavailable.");
    }
  }

  async deleteTemplate(templateId: string): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.rpc("delete_prosm_time_shift_template", { p_template_id: templateId });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to delete this shift template.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Schedule service unavailable.");
    }
  }

  async listMine(): Promise<ServiceResult<MyShiftRow[]>> {
    try {
      const { data, error } = await this.client
        .from("shift_assignments")
        .select("id, shift_date, start_time, end_time, status, notes, cancelled_reason, sites(name)")
        .order("shift_date", { ascending: true });
      if (error) return createError(error.message);
      return createSuccess((data ?? []).map(mapMyShiftRow));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Schedule service unavailable.");
    }
  }

  async listForSite(siteId: string, startDate: string, endDate: string): Promise<ServiceResult<SiteShiftRow[]>> {
    try {
      const { data, error } = await this.client.rpc("list_prosm_time_site_shifts", { p_site_id: siteId, p_start_date: startDate, p_end_date: endDate });
      if (error) return createError(error.message);
      return createSuccess(
        (data ?? []).map((row: { id: string; user_id: string; employee_name: string; shift_date: string; start_time: string; end_time: string; status: "scheduled" | "cancelled"; notes: string | null; cancelled_reason: string | null }) => ({
          id: row.id,
          userId: row.user_id,
          employeeName: row.employee_name,
          shiftDate: row.shift_date,
          startTime: row.start_time,
          endTime: row.end_time,
          status: row.status,
          notes: row.notes,
          cancelledReason: row.cancelled_reason,
        })),
      );
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Schedule service unavailable.");
    }
  }

  async assign(userId: string, siteId: string, shiftDate: string, startTime: string, endTime: string, shiftTemplateId?: string, notes?: string): Promise<ServiceResult<{ assignmentId: string }>> {
    try {
      const { data, error } = await this.client.rpc("assign_prosm_time_shift", {
        p_user_id: userId,
        p_site_id: siteId,
        p_shift_date: shiftDate,
        p_start_time: startTime,
        p_end_time: endTime,
        p_shift_template_id: shiftTemplateId ?? null,
        p_notes: notes?.trim() || null,
      });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to assign this shift.");
      return createSuccess({ assignmentId: data.assignmentId });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Schedule service unavailable.");
    }
  }

  async cancel(assignmentId: string, reason?: string): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.rpc("cancel_prosm_time_shift_assignment", { p_assignment_id: assignmentId, p_reason: reason?.trim() || null });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to cancel this shift.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Schedule service unavailable.");
    }
  }
}

export default new ShiftRepository();
