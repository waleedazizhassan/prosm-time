// Audit 2026-10-12, item 3 - the backend lifecycle suite (time_lifecycle.mjs
// from the E2E audit) as Vitest: clock in/out, breaks, double clock-in,
// outside the work area, backdating (T10), organisation and employee
// isolation, leave, timesheets and direct writes refused. The tests run in
// order on one database, like the original script.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let orgA: TestOrg;
let orgB: TestOrg;
let siteId: string;
let emp: TestMember;
let emp2: TestMember;
let emp3: TestMember;

const today = () => new Date().toISOString().slice(0, 10);
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600e3).toISOString();

const clockIn = (authId: string | null, options: { at?: string; lat?: number; lng?: number } = {}) =>
  t.as(authId, "select public.clock_in_prosm_time_attendance($1, $2, null, $3, $4, $5, 8) as r", [
    randomUUID(),
    siteId,
    options.at ?? null,
    options.lat ?? 30.02125,
    options.lng ?? 31.75812,
  ]);
const clockOut = (authId: string, options: { at?: string } = {}) =>
  t.as(authId, "select public.clock_out_prosm_time_attendance($1, $2, 30.02125, 31.75812, 8) as r", [randomUUID(), options.at ?? null]);
const openSession = async (member: TestMember) =>
  (await t.su<{ id: string; status: string; clock_in_at: string }>("select id, status, clock_in_at::text from attendance_sessions where user_id = $1 order by clock_in_at desc limit 1", [member.userId]))[0];
const count = async (authId: string, sql: string, params: unknown[]) => {
  const result = await t.as<{ n: number }>(authId, sql, params);
  if (result.error) throw new Error(result.error);
  return result.rows?.[0]?.n ?? 0;
};

beforeAll(async () => {
  t = await buildDatabase();
  orgA = await createOrg(t, "OrgA");
  orgB = await createOrg(t, "OrgB");
  siteId = await createSite(t, orgA, "Tower B");
  emp = await addMember(t, orgA, "employee", "Emp A");
  emp2 = await addMember(t, orgA, "employee", "Emp Two");
  emp3 = await addMember(t, orgA, "employee", "Emp Three");
  for (const member of [emp, emp2, emp3]) await assignToSite(t, siteId, member);
  await t.su("update sites set geofence_required = true, block_self_clock_out_outside_geofence = false where id = $1", [siteId]);
});

describe("attendance lifecycle", () => {
  it("T01 an anonymous caller cannot clock in", async () => {
    expect((await clockIn(null)).error).not.toBeNull();
  });

  it("T02 an employee clocks in inside the work area", async () => {
    expect((await clockIn(emp.authId)).error).toBeNull();
    expect((await openSession(emp)).status).toBe("clocked_in");
  });

  it("T03 a second clock-in while clocked in is refused", async () => {
    expect((await clockIn(emp.authId)).error).toMatch(/ALREADY CLOCKED IN/);
  });

  it("T04-T06 breaks: start and end; a colleague cannot end it", async () => {
    const session = await openSession(emp);
    expect((await t.as(emp.authId, "select public.start_prosm_time_break($1, $2)", [session.id, randomUUID()])).error).toBeNull();
    const [activeBreak] = await t.su<{ id: string }>("select id from break_events where user_id = $1 and status = 'active'", [emp.userId]);
    expect((await t.as(emp2.authId, "select public.end_prosm_time_break($1, $2)", [activeBreak.id, randomUUID()])).error).toMatch(/BREAK NOT FOUND/);
    expect((await t.as(emp.authId, "select public.end_prosm_time_break($1, $2)", [activeBreak.id, randomUUID()])).error).toBeNull();
    expect(await t.su("select 1 from break_events where user_id = $1 and status = 'active'", [emp.userId])).toHaveLength(0);
  });

  it("T07 an employee clocks out; the session closes", async () => {
    expect((await clockOut(emp.authId)).error).toBeNull();
    expect((await openSession(emp)).status).toBe("clocked_out");
  });

  it("T08 a clock-out with no open session is refused", async () => {
    expect((await clockOut(emp.authId)).error).toMatch(/NOT CURRENTLY CLOCKED IN/);
  });

  it("T09 a clock-in ~3 km from the site is recorded as an exception", async () => {
    const result = await clockIn(emp2.authId, { lat: 30.04, lng: 31.78 });
    expect(result.error).toBeNull();
    const [exceptions] = await t.su<{ n: number }>("select count(*)::int as n from geofence_exceptions where user_id = $1", [emp2.userId]);
    expect(exceptions.n).toBeGreaterThan(0);
    expect((await clockOut(emp2.authId)).error).toBeNull();
  });

  it("T10 a self-reported clock-in time 20 h back is not accepted as the time", async () => {
    expect((await clockIn(emp2.authId, { at: hoursAgo(20) })).error).toBeNull();
    const session = await openSession(emp2);
    expect((Date.now() - new Date(session.clock_in_at).getTime()) / 3600e3).toBeLessThan(0.1);
    expect((await clockOut(emp2.authId)).error).toBeNull();
  });
});

describe("isolation", () => {
  it("T11 another organisation's owner sees none of the attendance", async () => {
    expect(await count(orgB.owner.authId, "select count(*)::int as n from attendance_sessions where organization_id = $1", [orgA.id])).toBe(0);
  });

  it("T12 another organisation's member list has none of these people", async () => {
    const result = await t.as<{ email: string | null }>(orgB.owner.authId, "select * from public.list_prosm_time_visible_members()");
    expect(result.error).toBeNull();
    const emails = (result.rows ?? []).map((row) => row.email);
    for (const member of [orgA.owner, emp, emp2, emp3]) expect(emails).not.toContain(member.email);
  });

  it("T13 another organisation's owner cannot read the users table", async () => {
    expect(await count(orgB.owner.authId, "select count(*)::int as n from users where organization_id = $1", [orgA.id])).toBe(0);
  });

  it("T14 an employee cannot read a colleague's attendance", async () => {
    expect(await count(emp.authId, "select count(*)::int as n from attendance_sessions where user_id = $1", [emp2.userId])).toBe(0);
  });
});

describe("leave", () => {
  let leaveId: string;

  it("T15 leave cannot be approved over a day that already has attendance", async () => {
    expect((await t.as(emp.authId, "select public.request_prosm_time_leave('annual', $1, $1, 'trip')", [today()])).error).toBeNull();
    const [request] = await t.su<{ id: string }>("select id from leave_requests where user_id = $1 order by created_at desc limit 1", [emp.userId]);
    expect((await t.as(orgA.owner.authId, "select public.review_prosm_time_leave($1, 'approved', 'ok')", [request.id])).error).not.toBeNull();
  });

  it("T16 an employee requests leave (pending)", async () => {
    expect((await t.as(emp3.authId, "select public.request_prosm_time_leave('annual', $1, $1, 'trip')", [today()])).error).toBeNull();
    const [request] = await t.su<{ id: string; status: string }>("select id, status from leave_requests where user_id = $1 order by created_at desc limit 1", [emp3.userId]);
    expect(request.status).toBe("pending");
    leaveId = request.id;
  });

  it("T17 an employee cannot approve their own leave", async () => {
    await t.as(emp3.authId, "select public.review_prosm_time_leave($1, 'approved', null)", [leaveId]);
    const [request] = await t.su<{ status: string }>("select status from leave_requests where id = $1", [leaveId]);
    expect(request.status).toBe("pending");
  });

  it("T18 another organisation's owner cannot review it", async () => {
    expect((await t.as(orgB.owner.authId, "select public.review_prosm_time_leave($1, 'rejected', 'x')", [leaveId])).error).not.toBeNull();
  });

  it("T19 the owner approves it", async () => {
    expect((await t.as(orgA.owner.authId, "select public.review_prosm_time_leave($1, 'approved', 'ok')", [leaveId])).error).toBeNull();
    const [request] = await t.su<{ status: string }>("select status from leave_requests where id = $1", [leaveId]);
    expect(request.status).toBe("approved");
  });

  it("T19b a clock-in on an approved leave day is blocked", async () => {
    expect((await clockIn(emp3.authId)).error).toMatch(/APPROVED LEAVE/);
  });

  it("T19c ... also with a self-reported earlier time", async () => {
    expect((await clockIn(emp3.authId, { at: hoursAgo(2) })).error).toMatch(/APPROVED LEAVE/);
  });
});

describe("timesheets", () => {
  let timesheetId: string;
  const periodStart = () => new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
  const status = async () => (await t.su<{ status: string }>("select status from timesheets where id = $1", [timesheetId]))[0].status;

  it("T20 an employee cannot generate a colleague's timesheet", async () => {
    const result = await t.as(emp.authId, "select public.generate_prosm_time_timesheet($1, $2, $3)", [emp2.userId, periodStart(), today()]);
    expect(result.error).not.toBeNull();
  });

  it("T21 the owner generates the employee's timesheet", async () => {
    expect((await t.as(orgA.owner.authId, "select public.generate_prosm_time_timesheet($1, $2, $3)", [emp.userId, periodStart(), today()])).error).toBeNull();
    const [timesheet] = await t.su<{ id: string; total_worked_minutes: number }>("select id, total_worked_minutes from timesheets where user_id = $1 order by created_at desc limit 1", [emp.userId]);
    expect(Number(timesheet.total_worked_minutes)).toBeGreaterThanOrEqual(0);
    timesheetId = timesheet.id;
  });

  it("T22 a colleague cannot submit it", async () => {
    expect((await t.as(emp2.authId, "select public.submit_prosm_time_timesheet($1)", [timesheetId])).error).not.toBeNull();
  });

  it("T23 the employee submits their own timesheet", async () => {
    expect((await t.as(emp.authId, "select public.submit_prosm_time_timesheet($1)", [timesheetId])).error).toBeNull();
  });

  it("T24 the employee cannot approve their own timesheet", async () => {
    await t.as(emp.authId, "select public.approve_prosm_time_timesheet($1, 'approved', null)", [timesheetId]);
    expect(await status()).not.toBe("approved");
  });

  it("T25 the owner approves it", async () => {
    expect((await t.as(orgA.owner.authId, "select public.approve_prosm_time_timesheet($1, 'approved', 'ok')", [timesheetId])).error).toBeNull();
    expect(await status()).toBe("approved");
  });

  it("T26 the employee cannot edit the approved timesheet directly", async () => {
    const result = await t.as(emp.authId, "update timesheets set total_worked_minutes = 99999 where id = $1 returning id", [timesheetId]);
    expect(result.error !== null || (result.rows ?? []).length === 0).toBe(true);
    const [timesheet] = await t.su<{ total_worked_minutes: number }>("select total_worked_minutes from timesheets where id = $1", [timesheetId]);
    expect(Number(timesheet.total_worked_minutes)).not.toBe(99999);
  });

  it("T27 the employee cannot insert attendance directly, bypassing the RPC", async () => {
    const result = await t.as(emp.authId, "insert into attendance_sessions (organization_id, user_id, status, clock_in_at) values ($1, $2, 'clocked_out', now() - interval '10 hours')", [orgA.id, emp.userId]);
    expect(result.error).not.toBeNull();
  });
});
