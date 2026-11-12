// 2026-11-09 spec acceptance (payroll): the individual payslip and the detailed summary agree for
// every employee, totals and rounding included; history and approved payslips remain after an
// employee is deactivated or removed (migration 20261109190000 - removal used to fail outright).
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
const people: TestMember[] = [];
let cycleId = "";

async function ok<T>(result: Promise<{ rows: T[] | null; error: string | null }>): Promise<T> {
  const { rows, error } = await result;
  if (error) throw new Error(error);
  return rows![0];
}
const owner = (sql: string, params: unknown[] = []) => t.as(org.owner.authId, sql, params);
type Emp = { user_id: string | null; full_name: string; net_salary: string; total_earnings: string; total_deductions: string; total_installments: string; lines: { amount: string; category: string }[] };
type Report = { r: { employees: Emp[]; totals: { net: string; earnings: string; deductions: string }[] } };
const report = async (type: "payslip" | "summary") => (await ok<Report>(owner("select public.get_prosm_time_payroll_report($1, $2) as r", [cycleId, type]))).r;

beforeAll(async () => {
  t = await buildDatabase();
  expect(t.failures).toEqual([]);
  org = await createOrg(t, "Match Co");
  // these tests check the payroll arithmetic itself; the statutory deductions (2026-11-09) have their own tests
  await t.su("update payroll_settings set statutory = '{}'::jsonb");
  const comp = async (c: Record<string, unknown>) => (await ok<{ r: { id: string } }>(owner("select public.save_prosm_time_payroll_component(null, $1) as r", [JSON.stringify(c)]))).r.id;
  const basic = await comp({ name_ar: "الأساسي", category: "earning", source: "fixed", is_basic: true });
  const housing = await comp({ name_ar: "سكن", category: "allowance", source: "fixed" });
  const tax = await comp({ name_ar: "ضريبة", category: "deduction", source: "fixed" });
  // amounts that round: 3 people, odd cents
  for (const [i, amounts] of [[7333.33, 1111.11, 987.65], [8000.01, 0.99, 1234.56], [9999.99, 500.5, 0.01]].entries()) {
    const m = await addMember(t, org, "employee", `Person ${i + 1}`);
    people.push(m);
    await ok(owner("select public.save_prosm_time_payroll_profile($1, $2)", [m.userId, JSON.stringify({ legal_name: ["أحمد", "منى", "كريم"][i], currency: "EGP" })]));
    for (const [id, amount] of [[basic, amounts[0]], [housing, amounts[1]], [tax, amounts[2]]] as const) {
      await ok(owner("select public.set_prosm_time_payroll_profile_component($1, $2, $3, null, '2027-01-01')", [m.userId, id, amount]));
    }
  }
  cycleId = (await ok<{ r: { cycleId: string } }>(owner("select public.create_prosm_time_payroll_cycle('2027-05-01', '2027-05-31') as r"))).r.cycleId;
  await ok(owner("select public.transition_prosm_time_payroll_cycle($1, 'submit', null, null, true)", [cycleId]));
  await ok(owner("select public.transition_prosm_time_payroll_cycle($1, 'approve')", [cycleId]));
  await ok(owner("select public.transition_prosm_time_payroll_cycle($1, 'lock')", [cycleId]));
  await ok(owner("select public.publish_prosm_time_payslips($1, true)", [cycleId]));
});

describe("payslip and summary", () => {
  it("agree for every employee, and their lines add up to the net", async () => {
    const slips = await report("payslip");
    const summary = await report("summary");
    expect(slips.employees).toHaveLength(3);
    for (const slip of slips.employees) {
      const row = summary.employees.find((e) => e.user_id === slip.user_id)!;
      for (const key of ["net_salary", "total_earnings", "total_deductions", "total_installments"] as const) expect(row[key], key).toBe(slip[key]);
      const sum = (category: string[]) => slip.lines.filter((l) => category.includes(l.category)).reduce((s, l) => s + Math.round(Number(l.amount) * 100), 0);
      expect(sum(["earning", "allowance"]) - sum(["deduction"]) - sum(["installment"])).toBe(Math.round(Number(slip.net_salary) * 100));
    }
    const total = summary.employees.reduce((s, e) => s + Math.round(Number(e.net_salary) * 100), 0);
    expect(Math.round(Number(summary.totals[0].net) * 100)).toBe(total);
    // computed in cents: 733333 + 111111 - 98765 + 800001 + 99 - 123456 + 999999 + 50050 - 1
    expect(Math.round(Number(summary.totals[0].net) * 100)).toBe(2472371);
  });
});

describe("history after the person leaves", () => {
  it("a deactivated employee keeps their published payslip and their place in the reports", async () => {
    await t.su("update users set is_active = false where id = $1", [people[0].userId]);
    expect((await report("summary")).employees.map((e) => e.user_id)).toContain(people[0].userId);
    const mine = await t.as<{ r: { cycles: { cycleId: string }[] } }>(people[0].authId, "select public.list_my_prosm_time_payslip_cycles() as r");
    expect(mine.error ?? "").not.toMatch(/relation|constraint/);
  });

  it("a removed employee can be removed, and the approved figures stay", async () => {
    const before = await report("summary");
    const removed = before.employees.find((e) => e.user_id === people[1].userId)!;
    await t.su("delete from users where id = $1", [people[1].userId]);
    const after = await report("summary");
    expect(after.employees).toHaveLength(3);
    const row = after.employees.find((e) => e.full_name === removed.full_name)!;
    expect(row.net_salary).toBe(removed.net_salary);
    expect(after.totals[0].net).toBe(before.totals[0].net);
    const [{ n }] = await t.su<{ n: number }>("select count(*)::int as n from payroll_cycle_employees where cycle_id = $1", [cycleId]);
    expect(n).toBe(3);
    expect(await t.su("select id from payroll_profiles where user_id = $1", [people[1].userId])).toHaveLength(0);
  });
});
