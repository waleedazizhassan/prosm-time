// 2026-11-08 payroll module (migration 20261108130000): calculation, the three reports and their
// visibility rules, currencies, workflow, snapshots, publishing, scope, import, serials.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let other: TestOrg;
let siteA: string;
let siteB: string;
let amal: TestMember; // site A, EGP
let badr: TestMember; // site B, EGP
let carl: TestMember; // site A, USD
let nobody: TestMember; // no profile
let manager: TestMember; // manages site A, payroll rights granted
const c: Record<string, string> = {};
let cycleId = "";

type Line = { name_ar: string; amount: string; category: string; include_in_net: boolean; is_basic: boolean };
type Emp = { user_id: string; full_name: string; currency: string; net_salary: string; total_earnings: string; total_deductions: string; total_installments: string; combined_total: string; lines: Line[]; id: string; row_version: number };

const ownerRpc = <T,>(sql: string, params: unknown[] = []) => t.as<T>(org.owner.authId, sql, params);
async function ok<T>(result: Promise<{ rows: T[] | null; error: string | null }>): Promise<T> {
  const { rows, error } = await result;
  if (error) throw new Error(error);
  return rows![0];
}
const component = async (body: Record<string, unknown>) =>
  (await ok<{ r: { id: string } }>(ownerRpc("select public.save_prosm_time_payroll_component(null, $1) as r", [JSON.stringify(body)]))).r.id;
const setComponent = (member: TestMember, componentId: string, amount: number | null, from: string, percent: number | null = null) =>
  ok(ownerRpc("select public.set_prosm_time_payroll_profile_component($1, $2, $3, $4, $5)", [member.userId, componentId, amount, percent, from]));
const cycle = async () => (await ok<{ r: { employees: Emp[]; cycle: { status: string; row_version: number; cycle_version: number } } }>(ownerRpc("select public.get_prosm_time_payroll_cycle($1) as r", [cycleId]))).r;
const emp = (list: Emp[], member: TestMember) => list.find((row) => row.user_id === member.userId)!;
const report = async (member: TestMember, type: string, format = "preview") =>
  t.as<{ r: { employees: Emp[]; totals: { currency: string; net: string; combined: string }[]; serial: number | null; excluded: { userId: string }[]; draft: boolean } }>(
    member.authId, "select public.get_prosm_time_payroll_report($1, $2, null, null, $3) as r", [cycleId, type, format]);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Pay Co");
  other = await createOrg(t, "Other Co");
  siteA = await createSite(t, org, "A");
  siteB = await createSite(t, org, "B");
  amal = await addMember(t, org, "employee", "Amal");
  badr = await addMember(t, org, "employee", "Badr");
  carl = await addMember(t, org, "employee", "Carl");
  nobody = await addMember(t, org, "employee", "No Profile");
  manager = await addMember(t, org, "manager", "Payroll Manager");
  await assignToSite(t, siteA, amal);
  await assignToSite(t, siteB, badr);
  await assignToSite(t, siteA, carl);
  await assignToSite(t, siteA, nobody);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [siteA, manager.userId]);

  c.basic = await component({ name_ar: "الأساسي", name_en: "Basic", category: "earning", source: "fixed", is_basic: true, prorate: true, sort_order: 1 });
  c.housing = await component({ name_ar: "بدل سكن", name_en: "Housing", category: "allowance", source: "fixed", include_in_net: true, include_in_combined: true, sort_order: 2 });
  c.extra = await component({ name_ar: "بدل إضافي", name_en: "Extra allowance", category: "allowance", source: "fixed", include_in_net: false, include_in_combined: true, sort_order: 3 });
  c.tax = await component({ name_ar: "ضريبة", name_en: "Tax", category: "deduction", source: "fixed", calc_type: "percent", percent: 10, percent_base: "basic", sort_order: 10 });
  c.bonus = await component({ name_ar: "مكافأة", name_en: "Bonus", category: "earning", source: "variable", sort_order: 5 });
  c.penalty = await component({ name_ar: "جزاء", name_en: "Penalty", category: "deduction", source: "variable", sort_order: 11 });

  for (const [member, currency] of [[amal, "EGP"], [badr, "EGP"], [carl, "USD"]] as [TestMember, string][]) {
    await ok(ownerRpc("select public.save_prosm_time_payroll_profile($1, $2)", [member.userId, JSON.stringify({ currency, employee_code: member.userId.slice(0, 6) })]));
    await setComponent(member, c.basic, 10000, "2026-01-01");
    await setComponent(member, c.housing, 2000, "2026-01-01");
    await setComponent(member, c.extra, 1500, "2026-01-01");
    await setComponent(member, c.tax, null, "2026-01-01", 10);
  }
  await ok(ownerRpc("select public.save_prosm_time_installment_plan($1, 'سلفة', 1000, 4, '2027-01-01')", [amal.userId]));
});

describe("components", () => {
  it("never lets a line in the net be hidden from the payslip or the summary", async () => {
    const insert = await t.su("select 1").then(() =>
      t.db.query("insert into payroll_components (organization_id, name_ar, category, source, include_in_net, show_in_payslip) values ($1, 'x', 'earning', 'variable', true, false)", [org.id]).then(() => null, (e: Error) => e.message));
    expect(insert).toMatch(/payroll_components_net_visible/);
  });
});

describe("a cycle", () => {
  it("includes the people with a profile, once, and computes the net", async () => {
    const created = await ok<{ r: { cycleId: string; employees: number; skipped: { userId: string; reason: string }[] } }>(
      ownerRpc("select public.create_prosm_time_payroll_cycle('2027-01-01', '2027-01-31', null, 'January 2027') as r"));
    cycleId = created.r.cycleId;
    expect(created.r.employees).toBe(3);
    expect(created.r.skipped.find((row) => row.userId === nobody.userId)?.reason).toBe("NO_PROFILE");
    const amalRow = emp((await cycle()).employees, amal);
    // 10000 + 2000 earnings, 10% tax = 1000, installment 250 (1000 / 4); the extra 1500 is outside the net
    expect(Number(amalRow.total_earnings)).toBe(12000);
    expect(Number(amalRow.total_deductions)).toBe(1000);
    expect(Number(amalRow.total_installments)).toBe(250);
    expect(Number(amalRow.net_salary)).toBe(10750);
    expect(Number(amalRow.combined_total)).toBe(13500);
    expect(amalRow.lines.find((line) => line.category === "installment")?.name_ar).toMatch(/قسط 1 من 4/);
  });

  it("refuses a second cycle for the same period and scope", async () => {
    expect((await ownerRpc("select public.create_prosm_time_payroll_cycle('2027-01-15', '2027-02-14', $1)", [siteA])).error).toMatch(/ALREADY COVERS/);
  });

  it("adds variable lines, with optimistic locking", async () => {
    const amalRow = emp((await cycle()).employees, amal);
    const saved = await ok<{ r: { id: string } }>(ownerRpc("select public.save_prosm_time_payroll_line($1, null, $2, 500, 'target met') as r", [amalRow.id, c.bonus]));
    expect(Number(emp((await cycle()).employees, amal).net_salary)).toBe(11250);
    expect((await ownerRpc("select public.save_prosm_time_payroll_line($1, $2, null, 600, null, 99)", [amalRow.id, saved.r.id])).error).toMatch(/CHANGED BY SOMEONE ELSE/);
    expect((await ownerRpc("select public.save_prosm_time_payroll_line($1, null, $2, 100)", [amalRow.id, c.basic])).error).toMatch(/ONLY VARIABLE/);
  });
});

describe("the three reports", () => {
  it("payslip and summary: only lines in the net, adding up to the net; the extra allowance never appears", async () => {
    for (const type of ["payslip", "summary"]) {
      const r = (await report(org.owner, type)).rows![0].r;
      const row = emp(r.employees, amal);
      expect(row.lines.some((line) => line.name_ar === "بدل إضافي")).toBe(false);
      const sum = row.lines.reduce((acc, line) => acc + (line.category === "earning" || line.category === "allowance" ? 1 : -1) * Number(line.amount), 0);
      expect(sum).toBe(Number(row.net_salary));
    }
  });

  it("combined: basic + allowances (the extra one included), totals per currency, never summed across currencies", async () => {
    const r = (await report(org.owner, "combined")).rows![0].r;
    const row = emp(r.employees, amal);
    expect(row.lines.map((line) => line.name_ar).sort()).toEqual(["الأساسي", "بدل إضافي", "بدل سكن"].sort());
    expect(r.totals.map((total) => total.currency).sort()).toEqual(["EGP", "USD"]);
    expect(Number(r.totals.find((total) => total.currency === "USD")!.combined)).toBe(13500);
  });

  it("gives every export its own serial number", async () => {
    const first = (await report(org.owner, "summary", "xlsx")).rows![0].r.serial;
    const second = (await report(org.owner, "summary", "xlsx")).rows![0].r.serial;
    expect(Number(second)).toBe(Number(first) + 1);
  });
});

describe("scope and permissions", () => {
  it("nobody gets payroll from a role; a granted manager sees only their site", async () => {
    expect((await t.as(manager.authId, "select public.get_prosm_time_payroll_cycle($1)", [cycleId])).error).toMatch(/PAYROLL AUTHORITY/);
    for (const key of ["payroll.view", "payroll.export_summary", "payroll.edit_draft", "payroll.approve"]) {
      await ok(ownerRpc("select public.set_prosm_time_user_permission_override($1, $2, true, 'payroll')", [manager.userId, key]));
    }
    // the cycle is organisation-wide: the manager sees the employees of site A only
    const seen = await t.as<{ r: { employees: Emp[] } }>(manager.authId, "select public.get_prosm_time_payroll_cycle($1) as r", [cycleId]);
    expect(seen.error).toBeNull();
    expect(seen.rows![0].r.employees.map((row) => row.user_id).sort()).toEqual([amal.userId, carl.userId].sort());
    const r = (await report(manager, "summary")).rows![0].r;
    expect(r.excluded.map((row) => row.userId)).toEqual([badr.userId]);
    // an organisation-wide cycle is not the manager's to submit
    expect((await t.as(manager.authId, "select public.transition_prosm_time_payroll_cycle($1, 'submit', null, null, true)", [cycleId])).error).toMatch(/PAYROLL AUTHORITY/);
  });

  it("another organisation sees nothing", async () => {
    expect((await t.as(other.owner.authId, "select public.get_prosm_time_payroll_cycle($1)", [cycleId])).error).toMatch(/NOT FOUND/);
  });

  it("an employee has no access to payroll", async () => {
    expect((await t.as(amal.authId, "select public.list_prosm_time_payroll_cycles() as r")).rows![0]).toEqual({ r: [] });
  });
});

describe("workflow, snapshot and publishing", () => {
  it("approves into version 1, pays the installment, and keeps the numbers when a profile changes later", async () => {
    const state = await cycle();
    expect((await ownerRpc("select public.transition_prosm_time_payroll_cycle($1, 'approve')", [cycleId])).error).toMatch(/ONLY A CYCLE IN REVIEW/);
    await ok(ownerRpc("select public.transition_prosm_time_payroll_cycle($1, 'submit', null, $2, true)", [cycleId, state.cycle.row_version]));
    await ok(ownerRpc("select public.transition_prosm_time_payroll_cycle($1, 'approve')", [cycleId]));
    const after = await cycle();
    expect(after.cycle.status).toBe("approved");
    expect(after.cycle.cycle_version).toBe(1);
    const [plan] = await t.su<{ paid_amount: string }>("select paid_amount from payroll_installment_plans where user_id = $1", [amal.userId]);
    expect(Number(plan.paid_amount)).toBe(250);
    await setComponent(amal, c.basic, 20000, "2027-01-01");
    const r = (await report(org.owner, "summary")).rows![0].r;
    expect(Number(emp(r.employees, amal).net_salary)).toBe(11250);
    expect(r.draft).toBe(false);
  });

  it("publishes payslips from a locked cycle only, to the person only", async () => {
    expect((await ownerRpc("select public.publish_prosm_time_payslips($1, true)", [cycleId])).error).toMatch(/LOCKED CYCLE ONLY/);
    await ok(ownerRpc("select public.transition_prosm_time_payroll_cycle($1, 'lock')", [cycleId]));
    await ok(ownerRpc("select public.publish_prosm_time_payslips($1, true)", [cycleId]));
    // self-service is off by default
    expect((await t.as<{ r: unknown[] }>(amal.authId, "select public.list_my_prosm_time_payslips() as r")).rows![0].r).toEqual([]);
    await ok(ownerRpc("select public.save_prosm_time_payroll_settings('{\"employee_self_service\": true}')"));
    const mine = await t.as<{ r: { cycleId: string }[] }>(amal.authId, "select public.list_my_prosm_time_payslips() as r");
    expect(mine.rows![0].r.map((row) => row.cycleId)).toEqual([cycleId]);
    const slip = await t.as<{ r: { employee: Emp } }>(amal.authId, "select public.get_my_prosm_time_payslip($1) as r", [cycleId]);
    expect(slip.rows![0].r.employee.user_id).toBe(amal.userId);
    expect(slip.rows![0].r.employee.lines.some((line) => line.name_ar === "بدل إضافي")).toBe(false);
  });

  it("reopens with a reason, withdrawing the payslips and the installment, and re-approves as version 2", async () => {
    expect((await ownerRpc("select public.transition_prosm_time_payroll_cycle($1, 'reopen', '')", [cycleId])).error).toMatch(/REASON/);
    await ok(ownerRpc("select public.transition_prosm_time_payroll_cycle($1, 'reopen', 'missing overtime')", [cycleId]));
    expect((await t.as(amal.authId, "select public.get_my_prosm_time_payslip($1)", [cycleId])).error).toMatch(/NOT AVAILABLE/);
    const [plan] = await t.su<{ paid_amount: string }>("select paid_amount from payroll_installment_plans where user_id = $1", [amal.userId]);
    expect(Number(plan.paid_amount)).toBe(0);
    await ok(ownerRpc("select public.recalculate_prosm_time_payroll_cycle($1)", [cycleId]));
    expect(Number(emp((await cycle()).employees, amal).net_salary)).toBe(10000 * 2 + 2000 - 2000 - 250 + 500);
    await ok(ownerRpc("select public.transition_prosm_time_payroll_cycle($1, 'submit', null, null, true)", [cycleId]));
    await ok(ownerRpc("select public.transition_prosm_time_payroll_cycle($1, 'approve')", [cycleId]));
    expect((await cycle()).cycle.cycle_version).toBe(2);
  });

  it("does not let whoever submitted approve (the real owner excepted)", async () => {
    const created = await ok<{ r: { cycleId: string } }>(t.as(manager.authId, "select public.create_prosm_time_payroll_cycle('2027-02-01', '2027-02-28', $1) as r", [siteA]));
    await ok(t.as(manager.authId, "select public.transition_prosm_time_payroll_cycle($1, 'submit', null, null, true)", [created.r.cycleId]));
    expect((await t.as(manager.authId, "select public.transition_prosm_time_payroll_cycle($1, 'approve')", [created.r.cycleId])).error).toMatch(/DOES NOT APPROVE/);
    expect((await ownerRpc("select public.transition_prosm_time_payroll_cycle($1, 'approve')", [created.r.cycleId])).error).toBeNull();
  });
});

describe("import", () => {
  it("checks every row and saves all or nothing", async () => {
    const created = await ok<{ r: { cycleId: string } }>(ownerRpc("select public.create_prosm_time_payroll_cycle('2027-03-01', '2027-03-31', $1) as r", [siteB]));
    const email = (await t.su<{ email: string }>("select email from users where id = $1", [badr.userId]))[0].email;
    const rows = [{ email, component: "مكافأة", amount: 300 }, { email: "nobody@x.y", component: "مكافأة", amount: 1 }, { email, component: "Unknown", amount: 1 }];
    const dry = await ok<{ r: { errors: { row: number; code: string }[]; saved: boolean } }>(
      ownerRpc("select public.import_prosm_time_payroll_lines($1, $2, 'march.xlsx', false) as r", [created.r.cycleId, JSON.stringify(rows)]));
    expect(dry.r.saved).toBe(false);
    expect(dry.r.errors.map((error) => error.code)).toEqual(["EMPLOYEE_NOT_IN_CYCLE", "UNKNOWN_COMPONENT"]);
    expect(await t.su("select id from payroll_cycle_lines where source = 'import'")).toHaveLength(0);
    const good = await ok<{ r: { saved: boolean } }>(
      ownerRpc("select public.import_prosm_time_payroll_lines($1, $2, 'march.xlsx', false) as r", [created.r.cycleId, JSON.stringify(rows.slice(0, 1))]));
    expect(good.r.saved).toBe(true);
    expect(await t.su("select id from payroll_cycle_lines where source = 'import'")).toHaveLength(1);
  });
});

describe("proration", () => {
  it("prorates a prorated component for someone who joined mid-period", async () => {
    const dina = await addMember(t, org, "employee", "Dina");
    await assignToSite(t, siteA, dina);
    await ok(ownerRpc("select public.save_prosm_time_payroll_profile($1, $2)", [dina.userId, JSON.stringify({ currency: "EGP", start_date: "2027-04-16" })]));
    await setComponent(dina, c.basic, 3000, "2027-04-16");
    const created = await ok<{ r: { cycleId: string } }>(ownerRpc("select public.create_prosm_time_payroll_cycle('2027-04-01', '2027-04-30', $1) as r", [siteA]));
    const [row] = await t.su<{ proration_factor: string; base_salary: string }>(
      "select proration_factor, base_salary from payroll_cycle_employees where cycle_id = $1 and user_id = $2", [created.r.cycleId, dina.userId]);
    expect(Number(row.proration_factor)).toBe(0.5);
    expect(Number(row.base_salary)).toBe(1500);
  });
});
