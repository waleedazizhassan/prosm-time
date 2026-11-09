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
  /** 2026-11-09 (owner): external labour only - employees have their payroll */
  workerName: string;
  workerNumber: string;
  contractorName: string | null;
  siteName: string | null;
  rateAmount: number | null;
  rateUnit: "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY" | null;
  currency: string | null;
  days: number;
  hours: number;
  amount: number | null;
  /** a totals row (per currency), added on the client */
  isTotal?: boolean;
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
    const rows: LaborCostRow[] = ((data ?? []) as { worker_name: string; worker_number: string; contractor_name: string | null; site_name: string | null; rate_amount: number | null;
      rate_unit: LaborCostRow["rateUnit"]; currency: string | null; days: number; hours: number; amount: number | null }[]).map((row) => ({
      workerName: row.worker_name,
      workerNumber: row.worker_number,
      contractorName: row.contractor_name,
      siteName: row.site_name,
      rateAmount: row.rate_amount === null ? null : Number(row.rate_amount),
      rateUnit: row.rate_unit,
      currency: row.currency,
      days: Number(row.days),
      hours: Number(row.hours),
      amount: row.amount === null ? null : Number(row.amount),
    }));
    // the total for the period, per currency (amounts are never added across currencies)
    const totals = new Map<string, LaborCostRow>();
    for (const row of rows) {
      if (row.amount === null) continue;
      const key = row.currency ?? "";
      const total = totals.get(key) ?? { workerName: "", workerNumber: "", contractorName: null, siteName: null, rateAmount: null, rateUnit: null, currency: row.currency, days: 0, hours: 0, amount: 0, isTotal: true };
      total.days += row.days;
      total.hours = Math.round((total.hours + row.hours) * 100) / 100;
      total.amount = Math.round(((total.amount ?? 0) + row.amount) * 100) / 100;
      totals.set(key, total);
    }
    rows.push(...totals.values());
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
