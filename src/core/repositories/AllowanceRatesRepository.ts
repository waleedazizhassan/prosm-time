import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

// Owner 2026-10-20 ("allowances like my PROSM Allow app, only easier"): each
// allowance is priced per site, per category of staff and per person - the
// later wins - and a worked day fills itself from those prices
// (20261020260000). A blank price inherits from the level before it.
export const RATE_FIELDS = ["meal", "expatriation", "transportation", "housing", "travel", "other", "overtimeHour", "extraDay"] as const;
export type RateField = (typeof RATE_FIELDS)[number];
export type Rates = Record<RateField, number | null>;

export interface RateScope {
  siteId: string | null;
  categoryId: string | null;
  userId: string | null;
}

export interface RateRow extends RateScope {
  id: string;
  rates: Rates;
}

export interface AllowanceCategory {
  id: string;
  name: string;
}

export interface MySiteRates {
  siteId: string;
  siteName: string;
  rates: Rates;
}

// v2.3.43 step 4 (item 6): how each daily allowance is calculated for the organisation.
export const BASIS_FIELDS = ["meal", "expatriation", "transportation", "housing", "travel", "other"] as const;
export type BasisField = (typeof BASIS_FIELDS)[number];
export type AllowanceBasis = "fixed_per_day" | "per_hour" | "per_extra_day";

export const EMPTY_RATES: Rates = { meal: null, expatriation: null, transportation: null, housing: null, travel: null, other: null, overtimeHour: null, extraDay: null };

interface RawRateRow {
  id: string;
  site_id: string | null;
  category_id: string | null;
  user_id: string | null;
  meal: number | null;
  expatriation: number | null;
  transportation: number | null;
  housing: number | null;
  travel: number | null;
  other: number | null;
  overtime_hour: number | null;
  extra_day: number | null;
}

const num = (value: number | string | null) => (value === null || value === undefined ? null : Number(value));

function ok<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}

function fail<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

class AllowanceRatesRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async listRates(): Promise<ServiceResult<RateRow[]>> {
    try {
      const { data, error } = await this.client
        .from("allowance_rates")
        .select("id, site_id, category_id, user_id, meal, expatriation, transportation, housing, travel, other, overtime_hour, extra_day");
      if (error) return fail(error.message);
      return ok(
        ((data ?? []) as RawRateRow[]).map((row) => ({
          id: row.id,
          siteId: row.site_id,
          categoryId: row.category_id,
          userId: row.user_id,
          rates: {
            meal: num(row.meal),
            expatriation: num(row.expatriation),
            transportation: num(row.transportation),
            housing: num(row.housing),
            travel: num(row.travel),
            other: num(row.other),
            overtimeHour: num(row.overtime_hour),
            extraDay: num(row.extra_day),
          },
        })),
      );
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Allowances service unavailable.");
    }
  }

  async setRates(scope: RateScope, rates: Rates): Promise<ServiceResult> {
    try {
      const { error } = await this.client.rpc("set_prosm_time_allowance_rates", {
        p_site_id: scope.siteId,
        p_category_id: scope.categoryId,
        p_user_id: scope.userId,
        p_rates: rates,
      });
      return error ? fail(error.message) : ok();
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Allowances service unavailable.");
    }
  }

  async listCategories(): Promise<ServiceResult<AllowanceCategory[]>> {
    try {
      const { data, error } = await this.client.from("allowance_categories").select("id, name").order("name", { ascending: true });
      if (error) return fail(error.message);
      return ok((data ?? []) as AllowanceCategory[]);
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Allowances service unavailable.");
    }
  }

  async saveCategory(categoryId: string | null, name: string): Promise<ServiceResult> {
    try {
      const { error } = await this.client.rpc("save_prosm_time_allowance_category", { p_category_id: categoryId, p_name: name });
      return error ? fail(error.message) : ok();
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Allowances service unavailable.");
    }
  }

  async deleteCategory(categoryId: string): Promise<ServiceResult> {
    try {
      const { error } = await this.client.rpc("delete_prosm_time_allowance_category", { p_category_id: categoryId });
      return error ? fail(error.message) : ok();
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Allowances service unavailable.");
    }
  }

  async listCategoryMembers(): Promise<ServiceResult<Record<string, string>>> {
    try {
      const { data, error } = await this.client.from("allowance_category_members").select("user_id, category_id");
      if (error) return fail(error.message);
      return ok(Object.fromEntries(((data ?? []) as { user_id: string; category_id: string }[]).map((row) => [row.user_id, row.category_id])));
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Allowances service unavailable.");
    }
  }

  async setCategoryMember(userId: string, categoryId: string | null): Promise<ServiceResult> {
    try {
      const { error } = await this.client.rpc("set_prosm_time_allowance_category_member", { p_user_id: userId, p_category_id: categoryId });
      return error ? fail(error.message) : ok();
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Allowances service unavailable.");
    }
  }

  async myRates(): Promise<ServiceResult<MySiteRates[]>> {
    try {
      const { data, error } = await this.client.rpc("get_prosm_time_my_allowance_rates");
      if (error) return fail(error.message);
      return ok((data ?? []) as MySiteRates[]);
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Allowances service unavailable.");
    }
  }

  async getBasis(): Promise<ServiceResult<Record<BasisField, AllowanceBasis>>> {
    try {
      const { data, error } = await this.client.from("allowance_basis").select("allowance_key, basis");
      if (error) return fail(error.message);
      const basis = Object.fromEntries(BASIS_FIELDS.map((field) => [field, "fixed_per_day"])) as Record<BasisField, AllowanceBasis>;
      for (const row of (data ?? []) as { allowance_key: BasisField; basis: AllowanceBasis }[]) basis[row.allowance_key] = row.basis;
      return ok(basis);
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Allowances service unavailable.");
    }
  }

  async setBasis(field: BasisField, basis: AllowanceBasis): Promise<ServiceResult> {
    try {
      const { error } = await this.client.rpc("set_prosm_time_allowance_basis", { p_allowance_key: field, p_basis: basis });
      return error ? fail(error.message) : ok();
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Allowances service unavailable.");
    }
  }
}

export default new AllowanceRatesRepository();
