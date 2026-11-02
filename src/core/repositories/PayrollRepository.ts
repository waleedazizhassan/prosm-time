import DatabaseManager from "../database/DatabaseManager";

export interface PayrollRow {
  userId: string;
  fullName: string;
  email: string;
  daysWorked: number;
  workedMinutes: number;
  overtimeMinutes: number;
  overtimeWeightedMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  deductionMinutes: number;
  absenceDays: number;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  leaveDeduction: number;
  allowances: number;
  overtimeAmount: number;
  currency: string;
}

export interface LaborCostRow {
  projectName: string | null;
  siteName: string | null;
  userFullName: string;
  hours: number;
  cost: number | null;
  currency: string | null;
}

export interface PayrollTemplate {
  id: string;
  name: string;
  columns: string[];
}

class PayrollRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async canExport(): Promise<boolean> {
    const { data } = await this.client.rpc("prosm_time_can_export_payroll");
    return data === true;
  }

  async list(startDate: string, endDate: string): Promise<{ rows: PayrollRow[]; error: string | null }> {
    const { data, error } = await this.client.rpc("list_prosm_time_report_payroll", { p_start_date: startDate, p_end_date: endDate });
    if (error) return { rows: [], error: error.message };
    const rows = (data ?? []).map((row: Record<string, string | number>) => ({
      userId: String(row.user_id),
      fullName: String(row.full_name),
      email: String(row.email ?? ""),
      daysWorked: Number(row.days_worked),
      workedMinutes: Number(row.worked_minutes),
      overtimeMinutes: Number(row.overtime_minutes),
      overtimeWeightedMinutes: Number(row.overtime_weighted_minutes),
      lateMinutes: Number(row.late_minutes),
      earlyLeaveMinutes: Number(row.early_leave_minutes),
      deductionMinutes: Number(row.deduction_minutes),
      absenceDays: Number(row.absence_days),
      paidLeaveDays: Number(row.paid_leave_days),
      unpaidLeaveDays: Number(row.unpaid_leave_days),
      leaveDeduction: Number(row.leave_deduction),
      allowances: Number(row.allowances),
      overtimeAmount: Number(row.overtime_amount),
      currency: String(row.currency),
    }));
    return { rows, error: null };
  }

  async laborCost(startDate: string, endDate: string): Promise<{ success: boolean; message: string | null; data: LaborCostRow[] | null }> {
    const { data, error } = await this.client.rpc("list_prosm_time_report_labor_cost", { p_start_date: startDate, p_end_date: endDate });
    if (error) return { success: false, message: error.message, data: null };
    const rows = ((data ?? []) as { project_name: string | null; site_name: string | null; user_full_name: string; hours: number; cost: number | null; currency: string | null }[]).map((row) => ({
      projectName: row.project_name,
      siteName: row.site_name,
      userFullName: row.user_full_name,
      hours: Number(row.hours),
      cost: row.cost === null ? null : Number(row.cost),
      currency: row.currency,
    }));
    return { success: true, message: null, data: rows };
  }

  async listTemplates(): Promise<PayrollTemplate[]> {
    const { data } = await this.client.rpc("list_prosm_time_payroll_templates");
    return (data ?? []) as PayrollTemplate[];
  }

  async saveTemplate(name: string, columns: string[]): Promise<boolean> {
    const { error } = await this.client.rpc("save_prosm_time_payroll_template", { p_name: name, p_columns: columns });
    return !error;
  }

  async deleteTemplate(id: string): Promise<boolean> {
    const { error } = await this.client.rpc("delete_prosm_time_payroll_template", { p_id: id });
    return !error;
  }
}

export default new PayrollRepository();
