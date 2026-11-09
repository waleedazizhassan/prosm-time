// 2026-11-09 statutory deductions (migration 20261109240000): Egyptian social insurance, salary
// income tax and the martyrs' fund, from editable rules; per-person exemptions and insurable wage;
// components that apply to everyone; cycles made before the rules keep their numbers.
// Expected figures are worked by hand from the 2026 Egyptian values.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let basicId = "";
let transportId = "";
const people: Record<string, TestMember> = {};

async function ok<T>(result: Promise<{ rows: T[] | null; error: string | null }>): Promise<T> {
  const { rows, error } = await result;
  if (error) throw new Error(error);
  return rows![0];
}
const owner = (sql: string, params: unknown[] = []) => t.as(org.owner.authId, sql, params);
type Line = { name_en: string | null; amount: string; include_in_net: boolean; source: string; source_ref: { rule?: string } | null };
const linesOf = async (cycleId: string, m: TestMember) =>
  t.su<Line>("select l.name_en, l.amount, l.include_in_net, l.source, l.source_ref from payroll_cycle_lines l join payroll_cycle_employees e on e.id = l.cycle_employee_id where e.cycle_id = $1 and e.user_id = $2", [cycleId, m.userId]);
const rule = (lines: Line[], name: string) => lines.find((l) => l.source_ref?.rule === name);
const netOf = async (cycleId: string, m: TestMember) => Number((await t.su<{ n: string }>("select net_salary as n from payroll_cycle_employees where cycle_id = $1 and user_id = $2", [cycleId, m.userId]))[0].n);
const tax = async (annual: number) => Number((await t.su<{ v: string }>("select public.prosm_time_payroll_income_tax($1, (select config -> 'incomeTax' from payroll_country_packs where code = 'EG')) as v", [annual]))[0].v);

beforeAll(async () => {
  t = await buildDatabase();
  expect(t.failures).toEqual([]);
  org = await createOrg(t, "Cairo Co");
  const comp = async (c: Record<string, unknown>) => (await ok<{ r: { id: string } }>(owner("select public.save_prosm_time_payroll_component(null, $1) as r", [JSON.stringify(c)]))).r.id;
  basicId = await comp({ name_ar: "الأساسي", name_en: "Basic", category: "earning", source: "fixed", is_basic: true });
  transportId = await comp({ name_ar: "انتقال", name_en: "Transport", category: "allowance", source: "fixed", applies_to_all: true, default_amount: 500, taxable: false });
  for (const [key, basic] of [["mid", 20000], ["low", 2000], ["high", 100000], ["exempt", 20000], ["fixedWage", 20000]] as const) {
    const m = await addMember(t, org, "employee", `Person ${key}`);
    people[key] = m;
    await ok(owner("select public.save_prosm_time_payroll_profile($1, $2)", [m.userId, JSON.stringify({ currency: "EGP" })]));
    await ok(owner("select public.set_prosm_time_payroll_profile_component($1, $2, $3, null, '2027-01-01')", [m.userId, basicId, basic]));
  }
  await ok(owner("select public.save_prosm_time_payroll_profile($1, $2)", [people.exempt.userId, JSON.stringify({ currency: "EGP", insurance_exempt: true, tax_exempt: true })]));
  await ok(owner("select public.save_prosm_time_payroll_profile($1, $2)", [people.fixedWage.userId, JSON.stringify({ currency: "EGP", insurable_wage: 5000 })]));
  // one person has their own transport value, which wins over the default
  await ok(owner("select public.set_prosm_time_payroll_profile_component($1, $2, 800, null, '2027-01-01')", [people.mid.userId, transportId]));
});

describe("a new organisation", () => {
  // 2026-11-09: there is always somewhere to enter the salary
  it("starts with a Basic salary component", async () => {
    await t.su("select public.prosm_time_seed_basic_component($1)", [org.id]); // the fixture removed the seeded one; seeding again is safe
    const rows = await t.su<{ name_en: string }>("select name_en from payroll_components where organization_id = $1 and is_basic", [org.id]);
    expect(rows).toHaveLength(1);
    await t.su("select public.prosm_time_seed_basic_component($1)", [org.id]);
    expect(await t.su("select 1 from payroll_components where organization_id = $1 and is_basic", [org.id])).toHaveLength(1);
  });
});

describe("the Egyptian tax table", () => {
  it("brackets after the exemption, and the high-income tiers", async () => {
    expect(await tax(197956)).toBeCloseTo(29341.2, 2); // 1,500 + 2,250 + 25,591.20
    expect(await tax(30000)).toBe(0);
    expect(await tax(650000)).toBeCloseTo(55000 * 0.1 + 15000 * 0.15 + 130000 * 0.2 + 200000 * 0.225 + 250000 * 0.25, 2); // 0% band dropped
    expect(await tax(1157956)).toBeCloseTo(400000 * 0.225 + 757956 * 0.25, 2); // above 900k: starts at 22.5%
    expect(await tax(1300000)).toBeCloseTo(1200000 * 0.25 + 100000 * 0.275, 2); // above 1.2m
  });
});

describe("a cycle under the Egyptian rules", () => {
  let cycleId = "";
  beforeAll(async () => {
    cycleId = (await ok<{ r: { cycleId: string } }>(owner("select public.create_prosm_time_payroll_cycle('2027-03-01', '2027-03-31') as r"))).r.cycleId;
  });

  it("insurance at the cap, tax after insurance and exemption, the fund, the employer's share outside the net", async () => {
    const lines = await linesOf(cycleId, people.mid);
    expect(Number(rule(lines, "insurance_employee")!.amount)).toBe(1837); // 16,700 x 11%
    expect(Number(rule(lines, "insurance_employer")!.amount)).toBe(3131.25); // 16,700 x 18.75%
    expect(rule(lines, "insurance_employer")!.include_in_net).toBe(false);
    expect(Number(rule(lines, "income_tax")!.amount)).toBeCloseTo(2445.1, 2); // transport is not taxable
    expect(Number(rule(lines, "martyrs_fund")!.amount)).toBe(10.4); // 0.05% of 20,800
    expect(await netOf(cycleId, people.mid)).toBeCloseTo(20800 - 1837 - 2445.1 - 10.4, 2);
  });

  it("the insurable wage is raised to the minimum; no tax under the exemption", async () => {
    const lines = await linesOf(cycleId, people.low);
    expect(Number(rule(lines, "insurance_employee")!.amount)).toBe(297); // 2,700 x 11%
    expect(rule(lines, "income_tax")).toBeUndefined();
  });

  it("a high income loses the lower brackets", async () => {
    const lines = await linesOf(cycleId, people.high);
    expect(Number(rule(lines, "income_tax")!.amount)).toBeCloseTo((400000 * 0.225 + 757956 * 0.25) / 12, 2);
  });

  it("exempt people pay neither; a fixed insurable wage is used as set", async () => {
    const exempt = await linesOf(cycleId, people.exempt);
    expect(rule(exempt, "insurance_employee")).toBeUndefined();
    expect(rule(exempt, "income_tax")).toBeUndefined();
    expect(rule(exempt, "martyrs_fund")).toBeDefined();
    expect(Number(rule(await linesOf(cycleId, people.fixedWage), "insurance_employee")!.amount)).toBe(550);
  });

  it("a component for everyone uses its default, and a person's own value wins", async () => {
    const amount = async (m: TestMember) => Number((await linesOf(cycleId, m)).find((l) => l.name_en === "Transport")!.amount);
    expect(await amount(people.low)).toBe(500);
    expect(await amount(people.mid)).toBe(800);
  });

  it("statutory lines cannot be deleted by hand", async () => {
    const [line] = await t.su<{ id: string; row_version: number }>("select l.id, l.row_version from payroll_cycle_lines l join payroll_cycle_employees e on e.id = l.cycle_employee_id where e.cycle_id = $1 and l.source = 'statutory' limit 1", [cycleId]);
    expect((await owner("select public.delete_prosm_time_payroll_line($1, null)", [line.id])).error).toMatch(/COME FROM/);
  });

  it("the payslip shows the employee's deductions, not the employer's share", async () => {
    const report = await ok<{ r: { employees: { user_id: string; lines: { name_en: string | null }[] }[] } }>(owner("select public.get_prosm_time_payroll_report($1, 'payslip') as r", [cycleId]));
    const names = report.r.employees.find((e) => e.user_id === people.mid.userId)!.lines.map((l) => l.name_en);
    expect(names).toContain("Social insurance (employee)");
    expect(names).not.toContain("Social insurance (employer)");
  });
});

describe("the rules are the organisation's", () => {
  it("can be changed, are checked, and go back to the country's values", async () => {
    const current = (await ok<{ r: { config: Record<string, Record<string, unknown>>; countries: { code: string }[] } }>(owner("select public.get_prosm_time_payroll_statutory() as r"))).r;
    expect(current.countries.map((c) => c.code)).toContain("EG");
    const bad = { ...current.config, incomeTax: { ...current.config.incomeTax, brackets: [{ upTo: 50000, rate: 0 }, { upTo: 40000, rate: 10 }, { upTo: null, rate: 20 }] } };
    expect((await owner("select public.save_prosm_time_payroll_statutory($1)", [JSON.stringify(bad)])).error).toMatch(/RISE IN ORDER/);
    const changed = { ...current.config, insurance: { ...current.config.insurance, employeeRate: 10 } };
    await ok(owner("select public.save_prosm_time_payroll_statutory($1)", [JSON.stringify(changed)]));
    expect((await t.su<{ r: string }>("select statutory -> 'insurance' ->> 'employeeRate' as r from payroll_settings where organization_id = $1", [org.id]))[0].r).toBe("10");
    await ok(owner("select public.reset_prosm_time_payroll_statutory('EG')"));
    expect((await t.su<{ r: string }>("select statutory -> 'insurance' ->> 'employeeRate' as r from payroll_settings where organization_id = $1", [org.id]))[0].r).toBe("11");
    const worker = await addMember(t, org, "employee", "Not Payroll");
    expect((await t.as(worker.authId, "select public.save_prosm_time_payroll_statutory($1)", [JSON.stringify(changed)])).error).toMatch(/PAYROLL AUTHORITY|NOT IN PLAN|ACCESS/);
  });

  it("a cycle made before the rules keeps its numbers when recalculated", async () => {
    await t.su("update payroll_settings set statutory = '{}'::jsonb where organization_id = $1", [org.id]);
    const before = (await ok<{ r: { cycleId: string } }>(owner("select public.create_prosm_time_payroll_cycle('2027-04-01', '2027-04-30') as r"))).r.cycleId;
    await ok(owner("select public.reset_prosm_time_payroll_statutory('EG')"));
    await ok(owner("select public.recalculate_prosm_time_payroll_cycle($1)", [before]));
    expect((await linesOf(before, people.mid)).filter((l) => l.source === "statutory")).toHaveLength(0);
  });
});
