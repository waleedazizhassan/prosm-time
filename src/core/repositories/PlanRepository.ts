import DatabaseManager from "../database/DatabaseManager";

export interface PlanStatus {
  plan: "legacy" | "starter" | "business" | "pro" | "enterprise";
  status: "trial" | "active" | "expired" | "suspended";
  endsAt: string | null;
  graceEndsAt: string | null;
  employees: number;
  sites: number;
  maxEmployees: number | null;
  maxSites: number | null;
  /** 2026-11-10: active external workers, the number the licence allows (null = no limit), and the
   *  users billed: employees + one per 10 external workers. */
  externalWorkers?: number;
  maxExternalWorkers?: number | null;
  billedUsers?: number;
}

// The owner's plan: what it is, what is used, when it ends. PROSM sets plans;
// entering a code is the owner's only action, and nothing here takes payment.
class PlanRepository {
  async getStatus(): Promise<PlanStatus | null> {
    const { data, error } = await DatabaseManager.getClient().rpc("get_prosm_time_plan_status");
    if (error) return null;
    return data as PlanStatus;
  }

  async redeem(code: string): Promise<{ success: boolean; error?: string }> {
    const { data, error } = await DatabaseManager.getClient().rpc("redeem_prosm_time_activation_code", { p_code: code });
    if (error) return { success: false, error: error.message };
    return data as { success: boolean; error?: string };
  }
}

export default new PlanRepository();
