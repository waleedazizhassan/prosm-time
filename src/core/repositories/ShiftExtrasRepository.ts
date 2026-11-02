import DatabaseManager from "../database/DatabaseManager";

export interface OpenShiftRequest {
  id: string;
  name: string;
  status: "pending" | "approved" | "rejected";
}

export interface OpenShift {
  id: string;
  siteId: string;
  siteName: string;
  shiftDate: string;
  startTime: string;
  endTime: string;
  notes: string | null;
  status: "open" | "filled" | "cancelled";
  myRequest: "pending" | "approved" | "rejected" | null;
  canManage: boolean;
  requests: OpenShiftRequest[];
}

export interface ChecklistItem {
  id: string;
  label: string;
}

// docs/IDEAS.md 5 and 6: open shifts and end-of-shift checklists. Every rule is on the server.
class ShiftExtrasRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async listOpenShifts(): Promise<OpenShift[]> {
    const { data, error } = await this.client.rpc("list_prosm_time_open_shifts");
    if (error) return [];
    return ((data ?? []) as Record<string, never>[]).map((row) => ({
      id: row.id,
      siteId: row.site_id,
      siteName: row.site_name,
      shiftDate: row.shift_date,
      startTime: row.start_time,
      endTime: row.end_time,
      notes: row.notes,
      status: row.status,
      myRequest: row.my_request,
      canManage: row.can_manage,
      requests: row.requests ?? [],
    }));
  }

  async createOpenShift(siteId: string, date: string, start: string, end: string, notes: string): Promise<string | null> {
    const { error } = await this.client.rpc("create_prosm_time_open_shift", { p_site_id: siteId, p_shift_date: date, p_start_time: start, p_end_time: end, p_notes: notes.trim() || null });
    return error ? error.message : null;
  }

  async cancelOpenShift(id: string): Promise<boolean> {
    return !(await this.client.rpc("cancel_prosm_time_open_shift", { p_id: id })).error;
  }

  async requestOpenShift(id: string): Promise<boolean> {
    return !(await this.client.rpc("request_prosm_time_open_shift", { p_id: id })).error;
  }

  async decideRequest(requestId: string, approve: boolean): Promise<string | null> {
    const { error } = await this.client.rpc("decide_prosm_time_open_shift_request", { p_request_id: requestId, p_approve: approve });
    return error ? error.message : null;
  }

  async siteChecklist(siteId: string): Promise<ChecklistItem[]> {
    const { data, error } = await this.client.rpc("list_prosm_time_site_checklist", { p_site_id: siteId });
    return error ? [] : ((data ?? []) as ChecklistItem[]);
  }

  async setSiteChecklist(siteId: string, labels: string[]): Promise<boolean> {
    return !(await this.client.rpc("set_prosm_time_site_checklist", { p_site_id: siteId, p_labels: labels })).error;
  }

  async recordSessionChecklist(sessionId: string, doneIds: string[]): Promise<boolean> {
    return !(await this.client.rpc("record_prosm_time_session_checklist", { p_session_id: sessionId, p_done_item_ids: doneIds })).error;
  }
}

export default new ShiftExtrasRepository();
