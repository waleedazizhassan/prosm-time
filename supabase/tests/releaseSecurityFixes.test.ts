// Release audit 2026-11-16, migration 20261117170000: each finding fixed, proved the way the auditor found it.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let other: TestOrg;
let m1: TestMember;
let m2: TestMember;
let sup: TestMember;
let emp: TestMember;

const now = () => Math.floor(Date.now() / 1000);
const asClaims = async (authId: string, extra: Record<string, unknown>, sql: string, params: unknown[] = []) => {
  try {
    const rows = await t.db.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: authId, role: "authenticated", ...extra })]);
      await tx.exec("set local role authenticated");
      return (await tx.query(sql, params)).rows;
    });
    return { rows, error: null as string | null };
  } catch (error) {
    return { rows: null, error: error instanceof Error ? error.message : String(error) };
  }
};
const old = { aal: "aal1", amr: [{ method: "password", timestamp: now() - 4000 }] };
const fresh = () => ({ aal: "aal1", amr: [{ method: "password", timestamp: now() - 20 }] });
const grantSu = (who: TestMember, key: string) =>
  t.su("insert into user_permission_overrides (user_id, permission_id, is_granted) select $1, id, true from permissions where permission_key = $2 on conflict do nothing", [who.userId, key]);
const has = async (who: TestMember, key: string) => (await t.su<{ h: boolean }>("select public.prosm_time_user_has_permission_internal($1, $2) as h", [who.userId, key]))[0].h;

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "RelSec");
  other = await createOrg(t, "RelSecOther");
  const siteA = await createSite(t, org, "A");
  const siteB = await createSite(t, org, "B");
  m1 = await addMember(t, org, "manager", "M1");
  m2 = await addMember(t, org, "manager", "M2");
  sup = await addMember(t, org, "supervisor", "Sup");
  emp = await addMember(t, org, "employee", "E1");
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager'), ($3, $4, 'manager')", [siteA, m1.userId, siteB, m2.userId]);
  await assignToSite(t, siteB, emp);
});

describe("SA-01 identity confirmation guards the actions the security screen promises", () => {
  it("permissions, roles and delegation refuse an old sign-in when the organisation asks, and pass a fresh one", async () => {
    await t.su("update organizations set security_step_up = true where id = $1", [org.id]);
    const calls = [
      ["select public.set_prosm_time_user_permission_override($1, 'reports.view', true, 'x')", [emp.userId]],
      ["select public.change_prosm_time_user_role($1, 'supervisor', 'x')", [emp.userId]],
      ["select public.grant_prosm_time_owner_authority($1, 'x')", [m1.userId]],
    ] as const;
    for (const [sql, params] of calls) {
      expect((await asClaims(org.owner.authId, old, sql, [...params])).error, sql).toMatch(/STEP_UP_REQUIRED/);
    }
    expect((await asClaims(org.owner.authId, fresh(), calls[0][0], [...calls[0][1]])).error).toBeNull();
    await t.su("update organizations set security_step_up = false where id = $1", [org.id]);
  });
});

describe("SA-02 nobody but the real owner changes their own permissions", () => {
  it("a full deputy cannot grant themselves a permission", async () => {
    expect((await t.as(org.owner.authId, "select public.grant_prosm_time_owner_authority($1, 'holiday')", [sup.userId])).error).toBeNull();
    const self = await t.as(sup.authId, "select public.set_prosm_time_user_permission_override($1, 'payroll.approve', true, 'me')", [sup.userId]);
    expect(self.error).toMatch(/YOUR OWN PERMISSIONS/);
    await t.as(org.owner.authId, "select public.revoke_prosm_time_owner_authority($1, 'back')", [sup.userId]);
    expect(await has(sup, "payroll.approve")).toBe(false);
  });
});

describe("SA-03 department managers and HR decide for people below them only", () => {
  it("a manager cannot appoint themselves; an appointed department manager cannot decide a peer's leave", async () => {
    await grantSu(m1, "departments.manage");
    const [{ id: dept }] = await t.su<{ id: string }>("insert into departments (organization_id, name) values ($1, 'Ops') returning id", [org.id]);
    expect((await t.as(m1.authId, "select public.set_prosm_time_department_manager($1, $2)", [dept, m1.userId])).error).toMatch(/APPOINT YOURSELF/);
    expect((await t.as(org.owner.authId, "select public.set_prosm_time_department_manager($1, $2)", [dept, emp.userId])).error).toMatch(/MANAGER ROLE/);
    expect((await t.as(org.owner.authId, "select public.set_prosm_time_department_manager($1, $2)", [dept, m1.userId])).error).toBeNull();
    await t.su("update users set department_id = $1 where id = any($2::uuid[])", [dept, [m2.userId, emp.userId]]);
    const [{ id: peerLeave }] = await t.su<{ id: string }>("insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, status) values ($1, $2, 'annual', date '2027-05-03', date '2027-05-03', 1, 'pending') returning id", [org.id, m2.userId]);
    expect((await t.as(m1.authId, "select public.review_prosm_time_leave($1, 'approved', 'x', null)", [peerLeave])).error).not.toBeNull();
    const [{ id: empLeave }] = await t.su<{ id: string }>("insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, status) values ($1, $2, 'annual', date '2027-05-10', date '2027-05-10', 1, 'pending') returning id", [org.id, emp.userId]);
    expect((await t.as(m1.authId, "select public.review_prosm_time_leave($1, 'approved', 'x', null)", [empLeave])).error).toBeNull();
  });
  it("hr.approve_all_requests is a managers-only permission", async () => {
    const r = await t.as(org.owner.authId, "select public.set_prosm_time_user_permission_override($1, 'hr.approve_all_requests', true, 'x')", [sup.userId]);
    expect(r.error).not.toBeNull();
  });
});

describe("SA-04 / SA-06 Connect", () => {
  it("a hand-written meeting invitation no longer lets anyone in, and members cannot write one", async () => {
    await t.su("insert into entitlements (organization_id, plan, status) values ($1, 'enterprise', 'active') on conflict (organization_id) do update set plan = 'enterprise', status = 'active'", [org.id]);
    const meeting = (await t.as<{ r: string }>(m1.authId, "select public.prosm_time_connect_start_meeting('audio', $1) as r", [[m2.userId]])).rows![0].r;
    const forged = await t.as(emp.authId, "insert into connect_switchboard (organization_id, from_user, to_user, type, ref_id) values ($1, $2, $3, 'meeting_invite', $4)", [org.id, emp.userId, sup.userId, meeting]);
    expect(forged.error).not.toBeNull();
    await t.su("insert into connect_switchboard (organization_id, from_user, to_user, type, ref_id) values ($1, $2, $3, 'meeting_invite', $4)", [org.id, emp.userId, sup.userId, meeting]);
    expect((await t.as(sup.authId, "select public.prosm_time_connect_join_meeting($1)", [meeting])).error).toMatch(/NOT INVITED/);
    expect((await t.as(m2.authId, "select public.prosm_time_connect_join_meeting($1)", [meeting])).error).toBeNull();
  });
  it("usage is counted only for one's own call or meeting, and within what a connection carries", async () => {
    const viewer = await addMember(t, other, "read_only", "Viewer");
    expect((await t.as(viewer.authId, "select public.record_prosm_time_connect_usage('audio', gen_random_uuid(), 'relay', 'global.relay.metered.ca', 2000000000, 60)")).error).toMatch(/INVALID USAGE/);
    const meeting = (await t.su<{ id: string }>("select id from connect_meetings where host_id = $1 order by created_at desc limit 1", [m1.userId]))[0].id;
    expect((await t.as(m1.authId, "select public.record_prosm_time_connect_usage('meeting', $1, 'relay', 'x', 2000000000, 60)", [meeting])).error).toMatch(/INVALID USAGE/);
    expect((await t.as(m1.authId, "select public.record_prosm_time_connect_usage('meeting', $1, 'relay', 'x', 1000000, 60)", [meeting])).error).toBeNull();
  });
});

describe("SA-07 / SA-08 / SA-10", () => {
  it("the owner needs two-step verification on every plan when the organisation asks", async () => {
    await t.su("insert into entitlements (organization_id, plan, status) values ($1, 'business', 'active') on conflict (organization_id) do update set plan = 'business', status = 'active'", [other.id]);
    await t.su("update organizations set security_mfa = true where id = $1", [other.id]);
    expect((await t.as<{ m: boolean }>(other.owner.authId, "select public.prosm_time_user_requires_mfa($1) as m", [other.owner.userId])).rows![0].m).toBe(true);
    await t.su("update organizations set security_mfa = false where id = $1", [other.id]);
  });
  it("payroll staff never change their own pay", async () => {
    await grantSu(m2, "payroll.access"); await grantSu(m2, "payroll.manage_profiles");
    const r = await t.as(m2.authId, "select public.save_prosm_time_payroll_profile($1, '{}'::jsonb)", [m2.userId]);
    expect(r.error).toMatch(/OWN PAY/);
  });
  it("a locked payroll month closes attendance permissions too", async () => {
    const [{ id: cyc }] = await t.su<{ id: string }>(
      "insert into payroll_cycles (organization_id, title, period_start, period_end, status, policy_snapshot) values ($1, 'Jan', date '2026-01-01', date '2026-01-31', 'locked', '{}'::jsonb) returning id", [org.id]);
    await t.su("insert into payroll_cycle_employees (organization_id, cycle_id, user_id, full_name, currency) values ($1, $2, $3, 'E1', 'EGP')", [org.id, cyc, emp.userId]);
    const locked = await t.su<{ l: boolean }>("select public.prosm_time_pay_period_locked($1, date '2026-01-15', date '2026-01-15') as l", [emp.userId]);
    expect(locked[0].l).toBe(true);
    const r = await t.su("select public.prosm_time_require_day_open($1, date '2026-01-15')", [emp.userId]).then(() => null, (e: Error) => e.message);
    expect(r).toMatch(/PAY PERIOD IS LOCKED/);
  });
});
