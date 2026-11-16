// Owner 2026-11-16, migration 20261117110000: an administration's authority (HR, finance, ... - the permission sets)
// MOVES - completing a set for a second person takes the set's own given permissions from the first; shared keys,
// role permissions and the owner are untouched.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, type TestMember, type TestOrg } from "./support/fixtures";

const HR = ["hr.manage", "employees.view", "employees.create", "employees.edit", "leave.approve", "leave.manage_types", "leave.set_deduction",
  "departments.manage", "timesheets.approve", "announcements.publish", "reports.view"];
const FINANCE = ["payroll.access", "payroll.view", "payroll.view_cost", "payroll.edit_draft", "payroll.enter_monthly_variables", "payroll.review",
  "payroll.approve", "payroll.reopen", "payroll.publish_payslips", "payroll.export_payslips", "payroll.export_summary", "payroll.export_combined_allowances",
  "payroll.import", "payroll.manage_profiles", "payroll.manage_installments", "payroll.manage_settings", "payroll.view_audit_log", "allowances.view",
  "allowances.approve", "external_labor.view_pay", "external_labor.approve", "external_labor.export", "reports.view", "reports.export"];

let t: TestDatabase;
let org: TestOrg;
let first: TestMember;
let second: TestMember;

const has = async (who: TestMember) =>
  (await t.su<{ k: string }>("select p.permission_key as k from permissions p where public.prosm_time_user_has_permission_internal($1, p.permission_key)", [who.userId])).map((r) => r.k);
const give = async (who: TestMember, keys: string[]) => {
  const now = await has(who);
  for (const key of keys) {
    if (now.includes(key)) continue;
    const r = await t.as(org.owner.authId, "select public.set_prosm_time_user_permission_override($1, $2, true, 'move test')", [who.userId, key]);
    expect(r.error, key).toBeNull();
  }
};
const holders = async (set: string) =>
  ((await t.as<{ h: { id: string }[] }>(org.owner.authId, "select public.list_prosm_time_management_holders($1, null) as h", [set])).rows![0].h ?? []).map((h) => h.id);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "MgmtMove");
  first = await addMember(t, org, "manager", "First");
  second = await addMember(t, org, "manager", "Second");
});

describe("one manager per administration", () => {
  it("HR moves: the set's own permissions leave the first holder, shared ones stay", async () => {
    await give(first, [...HR, "payroll.view"]);
    expect(await holders("hr")).toEqual([first.userId]);
    await give(second, HR);
    const left = await has(first);
    for (const key of ["hr.manage", "employees.create", "leave.manage_types", "departments.manage"]) expect(left).not.toContain(key);
    for (const key of ["payroll.view", "reports.view", "timesheets.approve", "announcements.publish"]) expect(left).toContain(key);
    expect(await holders("hr")).toEqual([second.userId]);
    expect(await t.su("select 1 from audit_logs where action = 'MANAGEMENT_MOVED' and subject_user_id = $1", [first.userId])).toHaveLength(1);
  });

  it("finance moves the same way, without touching HR", async () => {
    await give(first, FINANCE);
    await give(second, FINANCE);
    expect(await holders("finance")).toEqual([second.userId]);
    expect(await has(first)).not.toContain("payroll.manage_settings");
    expect(await holders("hr")).toEqual([second.userId]);
  });

  it("part of a set moves nothing; an employee cannot list managers", async () => {
    const third = await addMember(t, org, "employee", "Third");
    await give(third, ["hr.manage", "employees.create"]);
    expect(await holders("hr")).toEqual([second.userId]);
    expect((await t.as(third.authId, "select public.list_prosm_time_management_holders('hr', null)")).error).toMatch(/PERMISSIONS.ASSIGN/);
  });
});
