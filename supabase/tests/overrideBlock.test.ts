// v2.3.43 step 1 (item 10): a Manager at a site they manage (anyone holding
// attendance.override_block there) passes the site's self-service clock-in
// blocks and the override is audited; employees and supervisors are still
// refused; clock-out outside the work area is always allowed with an
// exception; the Owner still does not clock in or out. Migration 20261025100000.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, clockOut, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let site: string;
let otherSite: string;
let employee: TestMember;
let supervisor: TestMember;
let manager: TestMember;
let otherManager: TestMember;

const inside = { latitude: 30.02125, longitude: 31.75812 };
const outside = { latitude: 30.2961, longitude: 31.7458 }; // ~30 km away

async function reset() {
  await t.su("update attendance_sessions set status = 'clocked_out', clock_out_at = now() where status = 'clocked_in'");
  await t.su("update sites set block_self_clock_in_after_grace = false, shift_start_time = null, outside_zone_policy = 'ALLOW_WITH_EXCEPTION'");
}

async function afterGrace(siteId: string) {
  // Shift started at midnight UTC with no grace: any later time is "late".
  await t.su("update sites set timezone = 'UTC', shift_start_time = '00:00', grace_tolerance_minutes = 0, block_self_clock_in_after_grace = true where id = $1", [siteId]);
}

async function overrideAudits(member: TestMember) {
  return t.su<{ reason: string; context: { blocks: string[] } }>(
    "select reason, context from audit_logs where action = 'attendance.override_block' and actor_user_id = $1 order by created_at",
    [member.userId],
  );
}

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Delta");
  site = await createSite(t, org, "Plant A");
  otherSite = await createSite(t, org, "Plant B");
  employee = await addMember(t, org, "employee", "Emp One");
  supervisor = await addMember(t, org, "supervisor", "Sup One");
  manager = await addMember(t, org, "manager", "Mgr One");
  otherManager = await addMember(t, org, "manager", "Mgr Two");
  for (const member of [employee, supervisor]) await assignToSite(t, site, member);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, manager.userId]);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [otherSite, otherManager.userId]);
  // The other site's manager also works at Plant A as an ordinary member.
  await assignToSite(t, site, otherManager);
});

describe("override of the clock-in blocks (item 10)", () => {
  it("the new permission is in the catalogue for Owner and Manager only", async () => {
    const rows = await t.su<{ role_key: string }>(
      "select r.role_key from role_default_permissions rdp join roles r on r.id = rdp.role_id join permissions p on p.id = rdp.permission_id where p.permission_key = 'attendance.override_block' order by 1",
    );
    expect(rows.map((row) => row.role_key)).toEqual(["manager", "owner"]);
  });

  it("inside the area with no block, everyone below the Owner clocks in and out normally", async () => {
    await reset();
    for (const member of [employee, supervisor, manager]) {
      expect((await clockIn(t, member, site, inside)).error).toBeNull();
      expect((await clockOut(t, member)).error).toBeNull();
    }
    expect(await overrideAudits(manager)).toHaveLength(0);
  });

  it("after the grace period: employee and supervisor refused, the site's manager passes and it is audited", async () => {
    await reset();
    await afterGrace(site);
    expect((await clockIn(t, employee, site, inside)).error).toMatch(/CLOCK_IN_BLOCKED_CONTACT_MANAGER/);
    expect((await clockIn(t, supervisor, site, inside)).error).toMatch(/CLOCK_IN_BLOCKED_CONTACT_MANAGER/);
    expect((await clockIn(t, manager, site, inside)).error).toBeNull();
    const audits = await overrideAudits(manager);
    expect(audits).toHaveLength(1);
    expect(audits[0].reason).toBe("after_grace");
  });

  it("a manager of another site is not exempt where they are only a member", async () => {
    await reset();
    await afterGrace(site);
    expect((await clockIn(t, otherManager, site, inside)).error).toMatch(/CLOCK_IN_BLOCKED_CONTACT_MANAGER/);
  });

  it("outside the area with policy BLOCK: employee and supervisor refused, manager passes (audited)", async () => {
    await reset();
    await t.su("update sites set outside_zone_policy = 'BLOCK' where id = $1", [site]);
    expect((await clockIn(t, employee, site, outside)).error).toMatch(/CLOCK_IN_OUTSIDE_AREA_CONTACT_MANAGER/);
    expect((await clockIn(t, supervisor, site, outside)).error).toMatch(/CLOCK_IN_OUTSIDE_AREA_CONTACT_MANAGER/);
    expect((await clockIn(t, manager, site, outside)).error).toBeNull();
    expect((await overrideAudits(manager)).at(-1)?.context.blocks).toEqual(["outside_zone"]);
  });

  it("outside the area with ALLOW_WITH_EXCEPTION (the default): recorded with an exception for everyone", async () => {
    await reset();
    const [{ policy }] = await t.su<{ policy: string }>("select outside_zone_policy as policy from sites where id = $1", [otherSite]);
    expect(policy).toBe("ALLOW_WITH_EXCEPTION");
    expect((await clockIn(t, employee, site, outside)).error).toBeNull();
    const exceptions = await t.su("select id from geofence_exceptions where user_id = $1", [employee.userId]);
    expect(exceptions.length).toBeGreaterThan(0);
  });

  it("an employee's clock-out outside the area is allowed with an exception, even if the old block flag is set", async () => {
    await reset();
    expect((await clockIn(t, employee, site, inside)).error).toBeNull();
    await t.su("update sites set block_self_clock_out_outside_geofence = true where id = $1", [site]);
    const [{ flag }] = await t.su<{ flag: boolean }>("select block_self_clock_out_outside_geofence as flag from sites where id = $1", [site]);
    expect(flag).toBe(false);
    const before = await t.su("select id from geofence_exceptions where user_id = $1", [employee.userId]);
    const out = await t.as(employee.authId, "select public.clock_out_prosm_time_attendance($1, null, $2, $3, 8) as r", [randomUUID(), outside.latitude, outside.longitude]);
    expect(out.error).toBeNull();
    const after = await t.su("select id from geofence_exceptions where user_id = $1", [employee.userId]);
    expect(after.length).toBe(before.length + 1);
  });

  it("the Owner still does not clock in, whatever the block", async () => {
    await reset();
    expect((await clockIn(t, org.owner, site, inside)).error).toMatch(/THE OWNER DOES NOT CLOCK IN OR OUT/);
    await afterGrace(site);
    expect((await clockIn(t, org.owner, site, outside)).error).toMatch(/THE OWNER DOES NOT CLOCK IN OR OUT/);
  });

  it("a supervisor granted the permission still needs to manage the site", async () => {
    await reset();
    await afterGrace(site);
    await t.su(
      "insert into user_permission_overrides (user_id, permission_id, is_granted, granted_by, reason) select $1, id, true, $2, 'test' from permissions where permission_key = 'attendance.override_block'",
      [supervisor.userId, org.owner.userId],
    );
    expect((await clockIn(t, supervisor, site, inside)).error).toMatch(/CLOCK_IN_BLOCKED_CONTACT_MANAGER/);
    await t.su("update site_assignments set role_at_site = 'manager' where user_id = $1 and site_id = $2", [supervisor.userId, site]);
    expect((await clockIn(t, supervisor, site, inside)).error).toBeNull();
  });

  it("the policy setter: the site's manager may, another manager may not, and the change is audited", async () => {
    expect((await t.as(otherManager.authId, "select public.set_prosm_time_site_outside_zone_policy($1, 'BLOCK')", [site])).error).toMatch(/AUTHORITY/);
    expect((await t.as(manager.authId, "select public.set_prosm_time_site_outside_zone_policy($1, 'BLOCK')", [site])).error).toBeNull();
    expect((await t.as(manager.authId, "select public.set_prosm_time_site_outside_zone_policy($1, 'NOPE')", [site])).error).toMatch(/INVALID/);
    const [{ block }] = await t.su<{ block: boolean }>("select block_self_clock_in_outside_geofence as block from sites where id = $1", [site]);
    expect(block).toBe(true);
    const audits = await t.su("select id from audit_logs where action = 'site.outside_zone_policy' and entity_id = $1", [site]);
    expect(audits).toHaveLength(1);
  });
});
