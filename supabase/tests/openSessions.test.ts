// v2.3.43 step 2 (item 11): open shifts - alert once at 12 h, automatic close
// at 24 h with pending hours that count nowhere until a manager reviews them,
// extension before the limit, stale shifts listed (not closed), one
// "has not clocked out" notice per shift. Migration 20261025110000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, createOrg, createSite, openSessionId, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let site: string;
let ahmed: TestMember;
let sara: TestMember;
let manager: TestMember;
let supervisor: TestMember;

async function backdate(member: TestMember, hours: number) {
  const id = await openSessionId(t, member);
  await t.su("update attendance_sessions set clock_in_at = now() - make_interval(hours => $2) where id = $1", [id, hours]);
  await t.su("update attendance_events set occurred_at = now() - make_interval(hours => $2) where session_id = $1", [id, hours]);
  return id as string;
}

const run = () => t.su<{ r: { alerted: number; closed: number } }>("select public.process_prosm_time_open_sessions() as r").then((rows) => rows[0].r);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Giza");
  site = await createSite(t, org, "Yard");
  ahmed = await addMember(t, org, "employee", "Ahmed Omar");
  sara = await addMember(t, org, "employee", "Sara Adel");
  manager = await addMember(t, org, "manager", "Yard Manager");
  supervisor = await addMember(t, org, "supervisor", "Yard Supervisor");
  for (const member of [ahmed, sara, supervisor]) await assignToSite(t, site, member);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, manager.userId]);
  // The policy applies to shifts opened from "now" on; let the test shifts qualify.
  await t.su("update organization_settings set open_session_policy_since = now() - interval '30 days' where organization_id = $1", [org.id]);
});

describe("open shifts (item 11)", () => {
  it("a 13-hour shift: the employee is asked and managers are told once, however often the job runs", async () => {
    expect((await clockIn(t, ahmed, site)).error).toBeNull();
    const id = await backdate(ahmed, 13);
    expect((await run()).alerted).toBe(1);
    expect((await run()).alerted).toBe(0);
    const checks = await t.su("select id from notifications where type = 'long_session_check' and user_id = $1", [ahmed.userId]);
    expect(checks).toHaveLength(1);
    const managerNotices = await t.su("select id from notifications where type = 'missing_clock_out' and related_entity_id = $1 and user_id = $2", [id, manager.userId]);
    expect(managerNotices).toHaveLength(1);
    const [{ status }] = await t.su<{ status: string }>("select status from attendance_sessions where id = $1", [id]);
    expect(status).toBe("clocked_in");
  });

  it("the employee answers 'still working'", async () => {
    expect((await t.as(ahmed.authId, "select public.respond_prosm_time_long_session('still_working')")).error).toBeNull();
    const [{ at }] = await t.su<{ at: string | null }>("select still_working_at as at from attendance_sessions where user_id = $1 and status = 'clocked_in'", [ahmed.userId]);
    expect(at).not.toBeNull();
  });

  it("at 24 hours the shift closes at the last known activity, flagged auto_closed with pending hours", async () => {
    const id = await backdate(ahmed, 25);
    await t.su("update attendance_sessions set still_working_at = clock_in_at + interval '14 hours', last_activity_at = null where id = $1", [id]);
    expect((await run()).closed).toBe(1);
    const [row] = await t.su<{ status: string; auto_closed: boolean; hours_review_status: string; worked: number }>(
      "select status, auto_closed, hours_review_status, extract(epoch from (clock_out_at - clock_in_at)) / 3600 as worked from attendance_sessions where id = $1",
      [id],
    );
    expect(row.status).toBe("clocked_out");
    expect(row.auto_closed).toBe(true);
    expect(row.hours_review_status).toBe("pending");
    expect(Number(row.worked)).toBeCloseTo(14, 1);
    const audits = await t.su("select id from audit_logs where action = 'attendance.auto_close' and entity_id = $1", [id]);
    expect(audits).toHaveLength(1);
  });

  it("pending hours count in no timesheet", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const monthAgo = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
    const result = await t.as(org.owner.authId, "select public.generate_prosm_time_timesheet($1, $2, $3) as r", [ahmed.userId, monthAgo, today]);
    expect(result.error).toBeNull();
    const [{ minutes }] = await t.su<{ minutes: number }>("select total_worked_minutes as minutes from timesheets where user_id = $1", [ahmed.userId]);
    expect(Number(minutes)).toBe(0);
  });

  it("only a manager of the employee's site reviews it, with a reason; then the hours count", async () => {
    const [{ id, clock_in_at }] = await t.su<{ id: string; clock_in_at: string }>("select id, clock_in_at from attendance_sessions where user_id = $1 and auto_closed", [ahmed.userId]);
    const end = new Date(new Date(clock_in_at).getTime() + 9 * 3600000).toISOString();
    expect((await t.as(supervisor.authId, "select public.review_prosm_time_pending_session($1, $2, 'ok')", [id, end])).error).toMatch(/SESSIONS.REVIEW_PENDING/);
    expect((await t.as(manager.authId, "select public.review_prosm_time_pending_session($1, $2, '')", [id, end])).error).toMatch(/REASON/);
    expect((await t.as(manager.authId, "select public.review_prosm_time_pending_session($1, $2, 'left at 5, confirmed by phone')", [id, end])).error).toBeNull();
    const list = await t.as<{ session_id: string }>(manager.authId, "select * from public.list_prosm_time_pending_sessions()");
    expect(list.rows).toHaveLength(0);
    const today = new Date().toISOString().slice(0, 10);
    const monthAgo = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
    await t.as(org.owner.authId, "select public.generate_prosm_time_timesheet($1, $2, $3) as r", [ahmed.userId, monthAgo, today]);
    const [{ minutes }] = await t.su<{ minutes: number }>("select total_worked_minutes as minutes from timesheets where user_id = $1", [ahmed.userId]);
    expect(Number(minutes)).toBeCloseTo(540, 0);
    const audits = await t.su("select previous_state, new_state from audit_logs where action = 'attendance.review_pending_hours' and entity_id = $1", [id]);
    expect(audits).toHaveLength(1);
  });

  it("an extended shift is not closed at 24 hours", async () => {
    expect((await clockIn(t, sara, site)).error).toBeNull();
    const id = await backdate(sara, 20);
    const until = new Date(Date.now() + 6 * 3600000).toISOString();
    expect((await t.as(manager.authId, "select public.extend_prosm_time_session($1, $2, 'planned inventory night')", [id, until])).error).toBeNull();
    await backdate(sara, 25);
    expect((await run()).closed).toBe(0);
  });

  it("a shift opened before the policy is listed for review, not closed", async () => {
    await t.su("update attendance_sessions set status = 'clocked_out', clock_out_at = now() where user_id = $1", [sara.userId]);
    expect((await clockIn(t, sara, site)).error).toBeNull();
    const id = await backdate(sara, 60);
    await t.su("update organization_settings set open_session_policy_since = now() - interval '1 day' where organization_id = $1", [org.id]);
    expect((await run()).closed).toBe(0);
    const stale = await t.as<{ session_id: string }>(manager.authId, "select * from public.list_prosm_time_stale_open_sessions()");
    expect(stale.rows?.map((row) => row.session_id)).toEqual([id]);
  });

  it("the policy is the Owner's setting, validated and audited", async () => {
    expect((await t.as(manager.authId, "select public.set_prosm_time_session_policy(10, 20)")).error).toMatch(/SESSION_POLICY/);
    expect((await t.as(org.owner.authId, "select public.set_prosm_time_session_policy(20, 10)")).error).toMatch(/INVALID/);
    expect((await t.as(org.owner.authId, "select public.set_prosm_time_session_policy(10, 20)")).error).toBeNull();
    const audits = await t.su("select id from audit_logs where action = 'settings.session_policy'");
    expect(audits).toHaveLength(1);
  });

  it("discarding an offline action is audited", async () => {
    expect((await t.as(ahmed.authId, "select public.log_prosm_time_offline_discard('clock_in', '{\"at\":\"x\"}'::jsonb)")).error).toBeNull();
    expect(await t.su("select id from audit_logs where action = 'offline.discard' and actor_user_id = $1", [ahmed.userId])).toHaveLength(1);
  });
});
