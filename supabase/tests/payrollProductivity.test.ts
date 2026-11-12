// 2026-11-09 payroll usability (spec 15.14, migration 20261109120000): copy last cycle's variable
// lines as drafts; add one line to several people at once, all or nothing, within scope.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let siteA: string;
let siteB: string;
let a1: TestMember;
let a2: TestMember;
let b1: TestMember;
let managerA: TestMember;
let bonus = "";
let mayCycle = "";
let juneCycle = "";

async function ok<T>(result: Promise<{ rows: T[] | null; error: string | null }>): Promise<T> {
  const { rows, error } = await result;
  if (error) throw new Error(error);
  return rows![0];
}
const owner = (sql: string, params: unknown[] = []) => t.as(org.owner.authId, sql, params);
const ceOf = async (cycle: string, member: TestMember) =>
  (await t.su<{ id: string }>("select id from payroll_cycle_employees where cycle_id = $1 and user_id = $2", [cycle, member.userId]))[0].id;
const variableLines = async (cycle: string, member: TestMember) =>
  t.su<{ amount: string; notes: string | null }>(
    "select l.raw_amount as amount, l.notes from payroll_cycle_lines l join payroll_cycle_employees ce on ce.id = l.cycle_employee_id where ce.cycle_id = $1 and ce.user_id = $2 and l.source = 'variable'",
    [cycle, member.userId],
  );

beforeAll(async () => {
  t = await buildDatabase();
  expect(t.failures).toEqual([]);
  org = await createOrg(t, "Copy Co");
  // these tests check the payroll arithmetic itself; the statutory deductions (2026-11-09) have their own tests
  await t.su("update payroll_settings set statutory = '{}'::jsonb");
  siteA = await createSite(t, org, "A");
  siteB = await createSite(t, org, "B");
  a1 = await addMember(t, org, "employee", "A One");
  a2 = await addMember(t, org, "employee", "A Two");
  b1 = await addMember(t, org, "employee", "B One");
  managerA = await addMember(t, org, "manager", "Manager A");
  await assignToSite(t, siteA, a1);
  await assignToSite(t, siteA, a2);
  await assignToSite(t, siteB, b1);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [siteA, managerA.userId]);
  await ok(owner("select public.set_prosm_time_user_permission_override($1, 'payroll.enter_monthly_variables', true, 'site A variables')", [managerA.userId]));
  const basic = await ok<{ r: { id: string } }>(owner("select public.save_prosm_time_payroll_component(null, $1) as r", [JSON.stringify({ name_ar: "الأساسي", category: "earning", source: "fixed", is_basic: true })]));
  bonus = (await ok<{ r: { id: string } }>(owner("select public.save_prosm_time_payroll_component(null, $1) as r", [JSON.stringify({ name_ar: "مكافأة", category: "earning", source: "variable" })]))).r.id;
  for (const member of [a1, a2, b1]) {
    await ok(owner("select public.save_prosm_time_payroll_profile($1, '{\"legal_name\": \"موظف تجريبي\", \"currency\": \"EGP\"}')", [member.userId]));
    await ok(owner("select public.set_prosm_time_payroll_profile_component($1, $2, 5000, null, '2027-01-01')", [member.userId, basic.r.id]));
  }
  mayCycle = (await ok<{ r: { cycleId: string } }>(owner("select public.create_prosm_time_payroll_cycle('2027-05-01', '2027-05-31') as r"))).r.cycleId;
  await ok(owner("select public.save_prosm_time_payroll_line($1, null, $2, 750, 'night shifts')", [await ceOf(mayCycle, a1), bonus]));
  await ok(owner("select public.transition_prosm_time_payroll_cycle($1, 'submit', null, null, true)", [mayCycle]));
  await ok(owner("select public.transition_prosm_time_payroll_cycle($1, 'approve')", [mayCycle]));
  juneCycle = (await ok<{ r: { cycleId: string } }>(owner("select public.create_prosm_time_payroll_cycle('2027-06-01', '2027-06-30') as r"))).r.cycleId;
});

describe("copying last cycle's variables", () => {
  it("brings each person's variable lines over as drafts, once", async () => {
    const first = await ok<{ r: { copied: number; skipped: number } }>(owner("select public.copy_prosm_time_payroll_variables($1) as r", [juneCycle]));
    expect(first.r).toMatchObject({ copied: 1, skipped: 0 });
    expect(await variableLines(juneCycle, a1)).toEqual([{ amount: "750.00", notes: "night shifts" }]);
    const second = await ok<{ r: { copied: number; skipped: number } }>(owner("select public.copy_prosm_time_payroll_variables($1) as r", [juneCycle]));
    expect(second.r).toMatchObject({ copied: 0, skipped: 1 });
    const [{ net }] = await t.su<{ net: string }>("select net_salary as net from payroll_cycle_employees where id = $1", [await ceOf(juneCycle, a1)]);
    expect(Number(net)).toBe(5750);
  });
});

describe("one line for several people", () => {
  it("adds it to everyone chosen", async () => {
    const r = await ok<{ r: { added: number } }>(owner("select public.add_prosm_time_payroll_line_bulk($1, $2, $3, 300, 'Eid bonus') as r", [juneCycle, [await ceOf(juneCycle, a2), await ceOf(juneCycle, b1)], bonus]));
    expect(r.r.added).toBe(2);
    expect((await variableLines(juneCycle, b1)).map((l) => l.notes)).toEqual(["Eid bonus"]);
  });

  it("is all or nothing: one person outside the manager's sites and nobody gets it", async () => {
    const before = (await variableLines(juneCycle, a2)).length;
    const result = await t.as(managerA.authId, "select public.add_prosm_time_payroll_line_bulk($1, $2, $3, 100, 'x')", [juneCycle, [await ceOf(juneCycle, a2), await ceOf(juneCycle, b1)], bonus]);
    expect(result.error).toMatch(/AUTHORITY REQUIRED/);
    expect((await variableLines(juneCycle, a2)).length).toBe(before);
    expect((await t.as(managerA.authId, "select public.add_prosm_time_payroll_line_bulk($1, $2, $3, 100, 'site A')", [juneCycle, [await ceOf(juneCycle, a2)], bonus])).error).toBeNull();
  });

  it("refuses people from another cycle", async () => {
    expect((await owner("select public.add_prosm_time_payroll_line_bulk($1, $2, $3, 10)", [juneCycle, [await ceOf(mayCycle, a1)], bonus])).error).toMatch(/NOT IN THIS CYCLE/);
  });
});
