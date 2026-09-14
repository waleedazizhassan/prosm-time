import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

export type PayRateType = "HOURLY" | "MONTHLY";

export interface PayRate {
  id: string;
  rateType: PayRateType;
  rateAmount: number;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}
function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

interface PayRateRow {
  id: string;
  rate_type: PayRateType;
  rate_amount: number;
  currency: string;
  effective_from: string;
  effective_to: string | null;
}

function mapRow(row: PayRateRow): PayRate {
  return { id: row.id, rateType: row.rate_type, rateAmount: Number(row.rate_amount), currency: row.currency, effectiveFrom: row.effective_from, effectiveTo: row.effective_to };
}

// PROSM Time - compensation data for the PROSM Finance labor-cost
// bridge (2026-09-14, worker_pay_rates/set_worker_pay_rate,
// 20260914200000). Owner-only, both by RLS on the table itself and by
// set_worker_pay_rate's own server-side gate - this repository doesn't
// duplicate that check, it just surfaces what the server already
// enforces.
class PayRateRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async getCurrentForUser(userId: string): Promise<ServiceResult<PayRate | null>> {
    try {
      const { data, error } = await this.client
        .from("worker_pay_rates")
        .select("id, rate_type, rate_amount, currency, effective_from, effective_to")
        .eq("user_id", userId)
        .is("effective_to", null)
        .maybeSingle();
      if (error) return createError(error.message);
      return createSuccess(data ? mapRow(data) : null);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Pay rate service unavailable.");
    }
  }

  async setRateForUser(userId: string, rateType: PayRateType, rateAmount: number, currency: string = "EGP", effectiveFrom?: string): Promise<ServiceResult<{ rateId: string }>> {
    try {
      const { data, error } = await this.client.rpc("set_worker_pay_rate", {
        p_user_id: userId,
        p_site_worker_id: null,
        p_rate_type: rateType,
        p_rate_amount: rateAmount,
        p_currency: currency,
        p_effective_from: effectiveFrom ?? new Date().toISOString().slice(0, 10),
      });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to set this pay rate.");
      return createSuccess({ rateId: data.rateId });
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Pay rate service unavailable.");
    }
  }
}

export default new PayRateRepository();
