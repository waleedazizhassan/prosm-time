import { requireSupabaseClient } from "../api/supabaseClient";

// HR suite feature 4 (2026-11-11): tax and insurance rules per country. The server holds the one
// calculation (payroll and the calculator), the versions and the liability acknowledgement.

export interface TaxBracket { upTo: number | null; rate: number }
export interface TaxRelief { kind: "employee_contributions" | "fixed" | "percent"; code?: string; value?: number; cap?: number | null; name?: string }
export interface InsuranceRule { payer: "employee" | "employer"; rate: number; minBase?: number | null; maxBase?: number | null; nameAr?: string | null; nameEn?: string | null }
export interface InsuranceBranch { code: string; name?: string; baseCode: string; useFixedWage?: boolean; rules: InsuranceRule[] }
export interface InsuranceCategory { code: string; name?: string; branches: InsuranceBranch[] }
export interface Levy { code: string; enabled?: boolean; payer: "employee" | "employer"; baseCode: string; rate: number; nameAr?: string | null; nameEn?: string | null }

export interface TaxRules {
  schema: 2;
  bases: { code: string; kind: "basic" | "gross" | "taxable" | "insurable" }[];
  incomeTax?: { enabled: boolean; nameAr?: string | null; nameEn?: string | null; baseCode: string; period: "monthly" | "annual_div_12"; reliefs: TaxRelief[]; brackets: TaxBracket[]; tiers: { above: number; startBracket: number }[]; roundDown?: boolean };
  insurance?: { enabled: boolean; defaultCategory?: string; categories: InsuranceCategory[] };
  levies?: Levy[];
}

export interface TaxConfigState {
  country: string;
  currency: string;
  mode: "preset" | "custom" | "none";
  version: number | null;
  rules: TaxRules | Record<string, never>;
  official: TaxRules | null;
  officialNote: string | null;
  officialUpdatedAt: string | null;
  matchesOfficial: boolean;
  officialChangedSince: boolean;
  liability: { at: string | null; by: string | null };
  isOwner: boolean;
  openCycles: number;
  nextFreeMonth: string;
  versions: { id: string; version: number; country: string; currency: string; mode: "preset" | "custom"; copiedFromPreset: boolean; effectiveFrom: string; createdAt: string; createdBy: string | null; reason: string | null }[];
  packs: string[];
  missingCategory: { userId: string; name: string }[];
}

export interface PreviewLine { rule: string; payer: "employee" | "employer"; nameAr: string | null; nameEn: string | null; percent: number | null; base: number; amount: number; inNet: boolean; category?: string }
export interface Preview { lines: PreviewLine[]; gross: number; net: number; employerCost: number; employeeContributions: number }

type Result<T> = { data: T | null; error: string | null };

async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<Result<T>> {
  try {
    const { data, error } = await requireSupabaseClient().rpc(name, args);
    if (error) return { data: null, error: error.message };
    return { data: data as T, error: null };
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : "Service unavailable." };
  }
}

const TaxConfigRepository = {
  get: () => rpc<TaxConfigState>("get_prosm_time_tax_config"),
  preview: (rules: TaxRules | { preset: string }, input: Record<string, unknown>) => rpc<Preview>("preview_prosm_time_tax_config", { p_rules: rules, p_input: input }),
  save: (data: { mode: "preset" | "custom"; rules?: TaxRules; effectiveFrom: string; currency?: string; acknowledgeLiability?: boolean; copiedFromPreset?: boolean; reason?: string }) =>
    rpc<{ id: string; version: number }>("save_prosm_time_tax_config", { p_data: data }),
  changeCountry: (code: string, confirm: string, currency: string, acknowledge: boolean) =>
    rpc<{ effectiveFrom: string }>("change_prosm_time_payroll_country", { p_code: code, p_confirm: confirm, p_currency: currency, p_acknowledge: acknowledge }),
  setOrganizationCountry: (code: string) => rpc<{ success: boolean; readyRules: boolean }>("set_prosm_time_organization_country", { p_code: code }),
  categories: () => rpc<{ code: string; name: string }[]>("list_prosm_time_insurance_categories"),
};

export default TaxConfigRepository;

/** An empty document for a country with no ready rules - every value is the company's to enter. */
export function emptyRules(): TaxRules {
  return {
    schema: 2,
    bases: [{ code: "basic", kind: "basic" }, { code: "gross", kind: "gross" }, { code: "taxable", kind: "taxable" }, { code: "insurable", kind: "insurable" }],
    incomeTax: { enabled: false, baseCode: "taxable", period: "annual_div_12", reliefs: [], brackets: [{ upTo: null, rate: 0 }], tiers: [] },
    insurance: { enabled: false, defaultCategory: "general", categories: [{ code: "general", name: "", branches: [{ code: "social", baseCode: "basic", useFixedWage: true, rules: [{ payer: "employee", rate: 0 }, { payer: "employer", rate: 0 }] }] }] },
    levies: [],
  };
}
