// Audit 2026-10-12, item 4.4 - clock in/out on behalf only for people
// below the caller's role (20261013150000), and only by the Owner or a
// Manager (owner 2026-10-19, 20261019120000).
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let siteId: string;
let manager: TestMember;
let supervisor: TestMember;
let employee: TestMember;

const onBehalfIn = (caller: TestMember, subject: TestMember) =>
  t.as(caller.authId, "select public.admin_clock_in_prosm_time_attendance($1, $2, 'forgot phone', null, null, 30.02125, 31.75812, 8) as r", [subject.userId, siteId]);
const onBehalfOut = (caller: TestMember, subject: TestMember) =>
  t.as(caller.authId, "select public.admin_clock_out_prosm_time_attendance($1, 'forgot phone') as r", [subject.userId]);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  siteId = await createSite(t, org, "Tower B");
  manager = await addMember(t, org, "manager", "Mona Manager");
  supervisor = await addMember(t, org, "supervisor", "Sami Supervisor");
  employee = await addMember(t, org, "employee", "Omar Employee");
  for (const member of [manager, supervisor, employee]) await assignToSite(t, siteId, member);
  await t.su("update site_assignments set role_at_site = 'manager' where user_id = any($1)", [[manager.userId, supervisor.userId]]);
  for (const member of [manager, supervisor]) {
    for (const key of ["attendance.clock_in_on_behalf", "attendance.clock_out_on_behalf"]) {
      await t.su(
        "insert into user_permission_overrides (user_id, permission_id, is_granted, reason) select $1, id, true, 'test' from permissions where permission_key = $2 on conflict do nothing",
        [member.userId, key],
      );
    }
  }
});

describe("on behalf: Owner and Managers, only below them", () => {
  it("refuses a supervisor, even one granted the permission individually", async () => {
    expect((await onBehalfIn(supervisor, manager)).error).toMatch(/ONLY THE OWNER OR A MANAGER/);
    expect((await onBehalfIn(supervisor, employee)).error).toMatch(/ONLY THE OWNER OR A MANAGER/);
    expect((await onBehalfOut(supervisor, employee)).error).toMatch(/ONLY THE OWNER OR A MANAGER/);
  });

  it("does not give supervisors the on-behalf permissions by default", async () => {
    const [row] = await t.su<{ n: number }>(
      "select count(*)::int as n from role_default_permissions rdp join roles r on r.id = rdp.role_id join permissions p on p.id = rdp.permission_id where r.role_key = 'supervisor' and p.permission_key like 'attendance.clock_%_on_behalf'",
    );
    expect(row.n).toBe(0);
  });

  it("never lets anyone clock themselves in or out on their own behalf", async () => {
    expect((await onBehalfIn(manager, manager)).error).toMatch(/BELOW YOUR ROLE/);
    expect((await onBehalfOut(manager, manager)).error).toMatch(/BELOW YOUR ROLE/);
    expect((await onBehalfIn(org.owner, org.owner)).error).toMatch(/BELOW YOUR ROLE|OWNER/);
  });

  it("lets a manager clock an employee in and out", async () => {
    expect((await onBehalfIn(manager, employee)).error).toBeNull();
    expect((await onBehalfOut(manager, employee)).error).toBeNull();
  });

  it("lets a manager act for a supervisor, and refuses the reverse clock-out", async () => {
    expect((await onBehalfIn(manager, supervisor)).error).toBeNull();
    expect((await onBehalfIn(org.owner, manager)).error).toBeNull();
    expect((await onBehalfOut(supervisor, manager)).error).toMatch(/ONLY THE OWNER OR A MANAGER/);
    expect((await onBehalfOut(org.owner, manager)).error).toBeNull();
  });
});
