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
