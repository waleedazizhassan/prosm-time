// Owner 2026-10-19: the Owner gives permissions to anyone below; a Manager
// passes on to Supervisors at their sites only what they hold; leave
// approval and acting on someone's behalf stay with Managers. Migration
// 20261019140000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let manager: TestMember;
let supervisor: TestMember;
let otherSupervisor: TestMember;
let employee: TestMember;

async function siteManager(role: string, name: string, siteId: string): Promise<TestMember> {
  const member = await addMember(t, org, role, name);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [siteId, member.userId]);
  return member;
}

const grant = (caller: TestMember, target: TestMember, key: string, isGranted = true) =>
  t.as(caller.authId, "select public.set_prosm_time_user_permission_override($1, $2, $3, 'test')", [target.userId, key, isGranted]);
const clear = (caller: TestMember, target: TestMember, key: string) =>
  t.as(caller.authId, "select public.clear_prosm_time_user_permission_override($1, $2, 'test')", [target.userId, key]);
const effective = async (caller: TestMember, target: TestMember) =>
  t.as<{ p: string[] }>(caller.authId, "select public.get_prosm_time_effective_permissions($1) as p", [target.userId]);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  const siteA = await createSite(t, org, "Site A");
  const siteB = await createSite(t, org, "Site B", { latitude: 30.3, longitude: 31.9 });
  manager = await siteManager("manager", "Manager A", siteA);
  supervisor = await siteManager("supervisor", "Supervisor A", siteA);
  otherSupervisor = await siteManager("supervisor", "Supervisor B", siteB);
  employee = await addMember(t, org, "employee", "Employee A");
  await t.su("insert into site_assignments (site_id, user_id) values ($1, $2)", [siteA, employee.userId]);
});

describe("permission delegation", () => {
  it("lets a Manager give a Supervisor at their site a permission the Manager holds, and take it back", async () => {
    expect((await grant(manager, supervisor, "schedules.manage")).error).toBeNull();
    expect((await effective(manager, supervisor)).rows?.[0].p).toContain("schedules.manage");
    expect((await clear(manager, supervisor, "schedules.manage")).error).toBeNull();
    expect((await effective(manager, supervisor)).rows?.[0].p).not.toContain("schedules.manage");
  });

  it("refuses what the Manager doesn't hold or must keep, and people not theirs", async () => {
    expect((await grant(manager, supervisor, "settings.manage")).error).toMatch(/ONLY PASS ON PERMISSIONS THEY HOLD/);
    expect((await grant(manager, supervisor, "leave.approve")).error).toMatch(/ONLY PASS ON PERMISSIONS THEY HOLD/);
    expect((await grant(manager, supervisor, "permissions.assign")).error).toMatch(/ONLY PASS ON PERMISSIONS THEY HOLD/);
    expect((await grant(manager, otherSupervisor, "schedules.manage")).error).toMatch(/SUPERVISORS AT THEIR SITES/);
    expect((await grant(manager, employee, "schedules.manage")).error).toMatch(/SUPERVISORS AT THEIR SITES/);
    expect((await grant(supervisor, employee, "reports.view")).error).toMatch(/PERMISSIONS.ASSIGN AUTHORITY REQUIRED/);
  });

  it("keeps leave approval and acting on someone's behalf for Managers, even when the Owner gives them", async () => {
    expect((await grant(org.owner, supervisor, "leave.approve")).error).toMatch(/FOR MANAGERS ONLY/);
    expect((await grant(org.owner, supervisor, "attendance.clock_in_on_behalf")).error).toMatch(/FOR MANAGERS ONLY/);
    expect((await grant(org.owner, supervisor, "reports.generate_pdf")).error).toBeNull();
    expect((await grant(org.owner, manager, "leave.approve", false)).error).toBeNull();
    expect((await grant(org.owner, manager, "leave.approve")).error).toBeNull();
  });
});
