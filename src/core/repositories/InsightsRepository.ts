import DatabaseManager from "../database/DatabaseManager";

export interface PersonFigure {
  name: string;
  days: number;
  minutes: number;
}

export interface AttendanceInsights {
  scheduled: number;
  attended: number;
  rate: number | null;
  repeatLate: PersonFigure[];
  repeatOvertime: PersonFigure[];
}

export interface ScheduleCost {
  shifts: number;
  regularHours: number;
  overtimeHours: number;
  regularCost: number;
  overtimeCost: number;
  unpricedShifts: number;
  currency: string | null;
}

export interface ProjectBudget {
  projectId: string;
  projectName: string;
  siteName: string;
  budget: number | null;
  spent: number;
  hours: number;
  unpricedHours: number;
}

// docs/IDEAS.md 2, 3 and 7: figures for managers, each checked on the server.
class InsightsRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async attendance(startDate: string, endDate: string): Promise<AttendanceInsights | null> {
    const { data, error } = await this.client.rpc("get_prosm_time_attendance_insights", { p_start_date: startDate, p_end_date: endDate });
    return error ? null : (data as AttendanceInsights);
  }

  async scheduleCost(siteId: string, startDate: string, endDate: string): Promise<ScheduleCost | null> {
    const { data, error } = await this.client.rpc("get_prosm_time_schedule_cost", { p_site_id: siteId, p_start_date: startDate, p_end_date: endDate });
    return error ? null : (data as ScheduleCost);
  }

  async projectBudgets(): Promise<ProjectBudget[]> {
    const { data, error } = await this.client.rpc("list_prosm_time_project_budgets");
    if (error) return [];
    return ((data ?? []) as Record<string, string | number | null>[]).map((row) => ({
      projectId: String(row.project_id),
      projectName: String(row.project_name),
      siteName: String(row.site_name),
      budget: row.budget === null ? null : Number(row.budget),
      spent: Number(row.spent),
      hours: Number(row.hours),
      unpricedHours: Number(row.unpriced_hours),
    }));
  }

  async setProjectBudget(projectId: string, amount: number | null): Promise<boolean> {
    const { error } = await this.client.rpc("set_prosm_time_project_budget", { p_project_id: projectId, p_amount: amount });
    return !error;
  }
}

export default new InsightsRepository();
