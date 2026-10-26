// v2.3.43 step 21 (audit, owner: "permissions and how they are given"): no one
// raises their own access - an employee or a manager granting themselves a
// permission, or a manager clearing a refusal on themselves, is refused.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let manager: TestMember;
let employee: TestMember;

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Escalation Co");
  const site = await createSite(t, org, "Main");
  manager = await addMember(t, org, "manager", "The Manager");
  employee = await addMember(t, org, "employee", "The Employee");
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, manager.userId]);
  await assignToSite(t, site, employee);
});

const grant = (member: TestMember, target: TestMember, key: string, granted = true) =>
  t.as(member.authId, "select public.set_prosm_time_user_permission_override($1, $2, $3, 'self')", [target.userId, key, granted]);

const holds = async (member: TestMember, key: string) =>
  (await t.su<{ ok: boolean }>("select public.prosm_time_user_has_permission_internal($1, $2) as ok", [member.userId, key]))[0].ok;

describe("no self-escalation", () => {
  it("an employee cannot give themselves a permission", async () => {
    expect((await grant(employee, employee, "attendance.view")).error).not.toBeNull();
    expect(await holds(employee, "attendance.view")).toBe(false);
  });

  it("a manager cannot give themselves a permission they lack", async () => {
    expect(await holds(manager, "payroll.view_cost")).toBe(false);
    expect((await grant(manager, manager, "payroll.view_cost")).error).not.toBeNull();
    expect(await holds(manager, "payroll.view_cost")).toBe(false);
  });

  it("a manager cannot undo a permission the Owner took from them", async () => {
    expect((await t.as(org.owner.authId, "select public.set_prosm_time_user_permission_override($1, 'attendance.view', false, 'owner says no')", [manager.userId])).error).toBeNull();
    expect(await holds(manager, "attendance.view")).toBe(false);
    expect((await t.as(manager.authId, "select public.clear_prosm_time_user_permission_override($1, 'attendance.view', 'self')", [manager.userId])).error).not.toBeNull();
    expect(await holds(manager, "attendance.view")).toBe(false);
  });
});
