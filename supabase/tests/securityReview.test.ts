// Security review, owner 2026-10-20: the kiosk only for its site's managers,
// PIN hashes unreadable, GPS trails and photos scoped to managed sites, and
// account actions only on people below the caller. Migration 20261020190000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let siteA: string;
let siteB: string;
let managerA: TestMember;
let peerA: TestMember;
let managerB: TestMember;
let employee: TestMember;
let coworker: TestMember;

async function siteManager(name: string, siteId: string): Promise<TestMember> {
  const member = await addMember(t, org, "manager", name);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [siteId, member.userId]);
  await t.su(
    "insert into user_permission_overrides (user_id, permission_id, is_granted, reason) select $1, id, true, 'test' from permissions where permission_key = any($2) on conflict do nothing",
    [member.userId, ["attendance.view", "employees.manage_accounts", "sites.manage"]],
  );
  return member;
}

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  siteA = await createSite(t, org, "Site A");
  siteB = await createSite(t, org, "Site B", { latitude: 30.3, longitude: 31.9 });
  managerA = await siteManager("Manager A", siteA);
  peerA = await siteManager("Peer A", siteA);
  managerB = await siteManager("Manager B", siteB);
  employee = await addMember(t, org, "employee", "Lido");
  coworker = await addMember(t, org, "employee", "Sara");
  await assignToSite(t, siteA, employee);
  await assignToSite(t, siteA, coworker);
});

describe("employee kiosk removed (H1, H2)", () => {
  it("has no employee kiosk functions and no PIN column left (owner 2026-10-21)", async () => {
    const [fns] = await t.su<{ n: number }>(
      "select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and (p.proname like 'kiosk_clock_%_prosm_time_attendance%' or p.proname like '%kiosk_pin%' or p.proname = 'list_prosm_time_kiosk_roster')",
    );
    expect(fns.n).toBe(0);
    const [col] = await t.su<{ n: number }>("select count(*)::int as n from information_schema.columns where table_schema = 'public' and table_name = 'users' and column_name = 'kiosk_pin_hash'");
    expect(col.n).toBe(0);
    expect((await t.as(employee.authId, "select full_name from users where id = $1", [employee.userId])).error).toBeNull();
  });
});

describe("location trails (H4)", () => {
  it("shows a GPS trail only to managers of its site", async () => {
    expect((await clockIn(t, employee, siteA)).error).toBeNull();
    const [session] = await t.su<{ id: string }>("select id from attendance_sessions where user_id = $1 and status = 'clocked_in'", [employee.userId]);
    await t.su("delete from presence_sessions where attendance_session_id = $1", [session.id]);
    const [presence] = await t.su<{ id: string }>(
      "insert into presence_sessions (organization_id, attendance_session_id, user_id, site_id) values ($1, $2, $3, $4) returning id",
      [org.id, session.id, employee.userId, siteA],
    );
    await t.su("insert into location_samples (presence_session_id, user_id, latitude, longitude) values ($1, $2, 30.02, 31.75)", [presence.id, employee.userId]);
    const seen = async (member: TestMember) =>
      (await t.as<{ n: number }>(member.authId, "select count(*)::int as n from location_samples where user_id = $1", [employee.userId])).rows?.[0].n;
    expect(await seen(managerA)).toBe(1);
    expect(await seen(managerB)).toBe(0);
    expect(await seen(employee)).toBe(1);
  });

  it("shows a location plausibility flag only to managers of its site", async () => {
    await t.su(
      "insert into location_plausibility_flags (organization_id, user_id, site_id, previous_latitude, previous_longitude, previous_at, latitude, longitude, occurred_at, distance_meters, implied_speed_kmh) values ($1, $2, $3, 30, 31, now() - interval '1 minute', 31, 32, now(), 140000, 8400)",
      [org.id, employee.userId, siteA],
    );
    const seen = async (member: TestMember) =>
      (await t.as<{ n: number }>(member.authId, "select count(*)::int as n from location_plausibility_flags where user_id = $1", [employee.userId])).rows?.[0].n;
    expect(await seen(managerA)).toBe(1);
    expect(await seen(managerB)).toBe(0);
  });
});

describe("account actions (M1, M2)", () => {
  it("refuses removing a fellow manager or the Owner from a site", async () => {
    const remove = (caller: TestMember, subject: TestMember) => t.as(caller.authId, "select public.remove_prosm_time_site_assignment($1, $2)", [siteA, subject.userId]);
    expect((await remove(managerA, peerA)).error).toMatch(/BELOW YOUR ROLE/);
    expect((await remove(managerA, org.owner)).error).toMatch(/BELOW YOUR ROLE/);
  });

  it("refuses exporting or deleting the Owner or a peer, and audits what it allows", async () => {
    expect((await t.as(managerA.authId, "select public.export_prosm_time_employee_data($1)", [org.owner.userId])).error).toMatch(/NOT AUTHORIZED/);
    expect((await t.as(managerA.authId, "select public.authorize_prosm_time_employee_data_deletion($1)", [peerA.userId])).error).toMatch(/NOT AUTHORIZED/);
    expect((await t.as(managerB.authId, "select public.export_prosm_time_employee_data($1)", [employee.userId])).error).toMatch(/NOT AUTHORIZED/);

    expect((await t.as(managerA.authId, "select public.export_prosm_time_employee_data($1)", [employee.userId])).error).toBeNull();
    const [audit] = await t.su<{ n: number }>("select count(*)::int as n from audit_logs where action = 'EMPLOYEE_DATA_EXPORTED' and subject_user_id = $1", [employee.userId]);
    expect(audit.n).toBe(1);
  });
});
