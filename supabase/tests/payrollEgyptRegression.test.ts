// Step 0 of the HR suite (docs/features/PROSM-new-features-spec.md, owner 2026-11-11): the Egyptian
// payroll engine is protected before anything touches payroll. For each case a real cycle is computed by
// the engine, and its statutory lines (employee and employer insurance, salary tax, martyrs' fund) and net
// are checked two ways:
//   1. against an independent calculation written here from the rules the engine reads (the EG pack),
//      so a change in the engine's arithmetic is caught;
//   2. against the frozen results in fixtures/egypt-payroll-golden.json (written once from the engine as
//      it was on 2026-11-11), so ANY change in an Egyptian result is caught.
// The golden file is never rewritten by a normal run; UPDATE_EGYPT_GOLDEN=1 writes it (only on purpose).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, type TestMember, type TestOrg } from "./support/fixtures";

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "egypt-payroll-golden.json");

interface Case {
  key: string;
  basic: number;
  taxableAllowance?: number;
  nonTaxableAllowance?: number;
  preTax?: number;
  otherDeduction?: number;
  insurableWage?: number;
  insuranceExempt?: boolean;
  taxExempt?: boolean;
  startDate?: string;
  endDate?: string;
}

interface Pack {
  insurance: { enabled: boolean; employeeRate: number; employerRate: number; minWage: number; maxWage: number; base: string };
  incomeTax: { enabled: boolean; personalExemption: number; insuranceDeductible: boolean; brackets: { upTo: number | null; rate: number }[]; tiers: { above: number; startBracket: number }[]; roundDown?: boolean };
  martyrsFund: { enabled: boolean; rate: number };
}

// a monthly basic whose annual taxable pay (after insurance and the exemption) is `annual` - for the
// bracket and tier boundaries. Above the maximum insurable wage the insurance is a fixed amount; below
// it, it is a share of the basic itself.
const basicForAnnual = (annual: number, pack: Pack) => {
  const monthly = (annual + pack.incomeTax.personalExemption) / 12;
  const rate = pack.insurance.employeeRate / 100;
  const atMax = monthly + pack.insurance.maxWage * rate;
  const basic = atMax >= pack.insurance.maxWage ? atMax : monthly / (1 - rate);
  return Math.round(basic * 100) / 100;
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// the independent calculation, from the pack's rules
function annualTax(annual: number, tax: Pack["incomeTax"]): number {
  if (annual <= 0 || tax.brackets.length === 0) return 0;
  let start = 0;
  for (const tier of tax.tiers ?? []) if (annual > tier.above) start = Math.max(start, tier.startBracket);
  start = Math.min(start, tax.brackets.length - 1);
  let lower = 0;
  let total = 0;
  for (let i = start; i < tax.brackets.length; i++) {
    let upper = tax.brackets[i].upTo;
    if (upper === null || annual < upper) upper = annual;
    if (upper > lower) total += ((upper - lower) * tax.brackets[i].rate) / 100;
    lower = Math.max(lower, upper);
    if (lower >= annual) break;
  }
  return round2(total);
}

function expected(lines: { gross: number; taxable: number; basic: number }, c: Case, pack: Pack) {
  let insEmployee = 0;
  let insEmployer = 0;
  if (pack.insurance.enabled && !c.insuranceExempt) {
    let base = c.insurableWage ?? lines.basic;
    if (base > 0) {
      base = Math.max(pack.insurance.minWage, Math.min(base, pack.insurance.maxWage));
      insEmployee = round2((base * pack.insurance.employeeRate) / 100);
      insEmployer = round2((base * pack.insurance.employerRate) / 100);
    }
  }
  let tax = 0;
  if (pack.incomeTax.enabled && !c.taxExempt && lines.taxable > 0) {
    const annual = (lines.taxable - (pack.incomeTax.insuranceDeductible ? insEmployee : 0)) * 12 - pack.incomeTax.personalExemption;
    tax = round2(annualTax(annual, pack.incomeTax) / 12);
    if (pack.incomeTax.roundDown) tax = Math.floor(tax);
  }
  const fund = pack.martyrsFund.enabled && lines.gross > 0 ? round2((lines.gross * pack.martyrsFund.rate) / 100) : 0;
  return { insEmployee, insEmployer, tax, fund };
}

let t: TestDatabase;
let org: TestOrg;
let pack: Pack;
let cycleId = "";
const people: Record<string, TestMember> = {};
const cases: Case[] = [];
type Result = { insEmployee: number; insEmployer: number; tax: number; fund: number; net: number };
const results: Record<string, Result> = {};
const inputs: Record<string, { gross: number; taxable: number; basic: number }> = {};

async function ok<T>(result: Promise<{ rows: T[] | null; error: string | null }>): Promise<T> {
  const { rows, error } = await result;
  if (error) throw new Error(error);
  return rows![0];
}

beforeAll(async () => {
  t = await buildDatabase();
  expect(t.failures).toEqual([]);
  org = await createOrg(t, "Egypt Regression Co");
  pack = (await t.su<{ c: Pack }>("select config as c from payroll_country_packs where code = 'EG'"))[0].c;
  const owner = (sql: string, params: unknown[] = []) => t.as(org.owner.authId, sql, params);
  const comp = async (c: Record<string, unknown>) => (await ok<{ r: { id: string } }>(owner("select public.save_prosm_time_payroll_component(null, $1) as r", [JSON.stringify(c)]))).r.id;
  const basicId = await comp({ name_ar: "الأساسي", name_en: "Basic", category: "earning", source: "fixed", is_basic: true });
  const taxableId = await comp({ name_ar: "حافز", name_en: "Incentive", category: "allowance", source: "fixed", taxable: true });
  const freeId = await comp({ name_ar: "انتقال", name_en: "Transport", category: "allowance", source: "fixed", taxable: false });
  const preTaxId = await comp({ name_ar: "تأمين طبي", name_en: "Health", category: "deduction", source: "fixed", pre_tax: true });
  const otherId = await comp({ name_ar: "سلفة", name_en: "Other", category: "deduction", source: "fixed" });

  // the cases: small and large pay, every bracket and tier boundary, the insurable wage limits,
  // exemptions, items taken off before tax, a fixed insurable wage, joining and leaving mid-month
  cases.push(
    { key: "minimum_wage_floor", basic: 2000 },
    { key: "just_above_min_insurable", basic: 2701 },
    { key: "small_pay_no_tax", basic: 3500 },
    { key: "mid_pay", basic: 9000, taxableAllowance: 1500, nonTaxableAllowance: 500 },
    { key: "at_max_insurable", basic: 16700 },
    { key: "above_max_insurable", basic: 25000 },
    { key: "bracket_40k_exact", basic: basicForAnnual(40000, pack) },
    { key: "bracket_40k_plus", basic: basicForAnnual(40000, pack) + 1 },
    { key: "bracket_55k_exact", basic: basicForAnnual(55000, pack) },
    { key: "bracket_70k_exact", basic: basicForAnnual(70000, pack) },
    { key: "bracket_200k_exact", basic: basicForAnnual(200000, pack) },
    { key: "bracket_400k_exact", basic: basicForAnnual(400000, pack) },
    { key: "tier_600k_below", basic: basicForAnnual(600000, pack) },
    { key: "tier_600k_above", basic: basicForAnnual(600000, pack) + 1 },
    { key: "tier_700k_above", basic: basicForAnnual(700000, pack) + 1 },
    { key: "tier_800k_above", basic: basicForAnnual(800000, pack) + 1 },
    { key: "tier_900k_above", basic: basicForAnnual(900000, pack) + 1 },
    { key: "tier_1_2m_above", basic: basicForAnnual(1200000, pack) + 1 },
    { key: "very_high_pay", basic: 250000, taxableAllowance: 20000 },
    { key: "pre_tax_items", basic: 12000, taxableAllowance: 3000, preTax: 487.47, otherDeduction: 300 },
    { key: "fixed_insurable_wage", basic: 20000, insurableWage: 5000 },
    { key: "insurance_exempt", basic: 15000, insuranceExempt: true },
    { key: "tax_exempt", basic: 15000, taxExempt: true },
    { key: "both_exempt", basic: 30000, insuranceExempt: true, taxExempt: true },
    { key: "joined_mid_month", basic: 12000, taxableAllowance: 1000, startDate: "2027-03-16" },
    { key: "left_mid_month", basic: 12000, endDate: "2027-03-10" },
  );
  for (const c of cases) {
    const m = await addMember(t, org, "employee", `Case ${c.key}`);
    people[c.key] = m;
    await ok(owner("select public.save_prosm_time_payroll_profile($1, $2)", [m.userId, JSON.stringify({
      legal_name: "موظف تجريبي", currency: "EGP", insurance_exempt: Boolean(c.insuranceExempt), tax_exempt: Boolean(c.taxExempt),
      insurable_wage: c.insurableWage ?? null, start_date: c.startDate ?? null, end_date: c.endDate ?? null,
    })]));
    const set = (id: string, amount: number) => ok(owner("select public.set_prosm_time_payroll_profile_component($1, $2, $3, null, '2027-01-01')", [m.userId, id, amount]));
    await set(basicId, c.basic);
    if (c.taxableAllowance) await set(taxableId, c.taxableAllowance);
    if (c.nonTaxableAllowance) await set(freeId, c.nonTaxableAllowance);
    if (c.preTax) await set(preTaxId, c.preTax);
    if (c.otherDeduction) await set(otherId, c.otherDeduction);
  }
  cycleId = (await ok<{ r: { cycleId: string } }>(owner("select public.create_prosm_time_payroll_cycle('2027-03-01', '2027-03-31') as r"))).r.cycleId;

  for (const c of cases) {
    const m = people[c.key];
    const lines = await t.su<{ amount: string; category: string; include_in_net: boolean; taxable: boolean; pre_tax: boolean; is_basic: boolean; source: string; rule: string | null }>(
      `select l.amount, l.category, l.include_in_net, l.taxable, l.pre_tax, l.is_basic, l.source, l.source_ref ->> 'rule' as rule
       from payroll_cycle_lines l join payroll_cycle_employees e on e.id = l.cycle_employee_id where e.cycle_id = $1 and e.user_id = $2`, [cycleId, m.userId]);
    const earn = lines.filter((l) => (l.category === "earning" || l.category === "allowance") && l.include_in_net);
    inputs[c.key] = {
      gross: earn.reduce((s, l) => s + Number(l.amount), 0),
      taxable: earn.filter((l) => l.taxable).reduce((s, l) => s + Number(l.amount), 0)
        - lines.filter((l) => l.category === "deduction" && l.include_in_net && l.pre_tax && l.source !== "statutory").reduce((s, l) => s + Number(l.amount), 0),
      basic: lines.filter((l) => l.is_basic).reduce((s, l) => s + Number(l.amount), 0),
    };
    const pick = (rule: string) => Number(lines.find((l) => l.rule === rule)?.amount ?? 0);
    const [ce] = await t.su<{ net: string }>("select net_salary as net from payroll_cycle_employees where cycle_id = $1 and user_id = $2", [cycleId, m.userId]);
    results[c.key] = { insEmployee: pick("insurance_employee"), insEmployer: pick("insurance_employer"), tax: pick("income_tax"), fund: pick("martyrs_fund"), net: Number(ce.net) };
  }
}, 600_000);

describe("Egyptian payroll engine - regression (step 0)", () => {
  it("covers enough cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(25);
  });

  it("matches the independent calculation from the rules, to the piastre", () => {
    for (const c of cases) {
      const want = expected(inputs[c.key], c, pack);
      const got = results[c.key];
      expect({ key: c.key, ...got, net: undefined }).toEqual({ key: c.key, ...want, net: undefined });
    }
  });

  it("the net is the earnings less the deductions (statutory included)", () => {
    for (const c of cases) {
      const r = results[c.key];
      const i = inputs[c.key];
      const ownDeductions = (c.preTax ?? 0) + (c.otherDeduction ?? 0);
      // a person outside the month (left before it) may have prorated deductions; the rule is checked where whole
      if (!c.startDate && !c.endDate) expect(round2(i.gross - ownDeductions - r.insEmployee - r.tax - r.fund)).toBe(r.net);
    }
  });

  it("gives exactly the frozen results (no Egyptian result may change)", () => {
    if (process.env.UPDATE_EGYPT_GOLDEN === "1" || !existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, JSON.stringify(results, null, 2) + "\n");
    }
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, Result>;
    expect(Object.keys(golden).sort()).toEqual(Object.keys(results).sort());
    for (const key of Object.keys(golden)) expect({ key, ...results[key] }).toEqual({ key, ...golden[key] });
  });
});
