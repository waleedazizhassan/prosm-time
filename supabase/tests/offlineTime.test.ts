// Audit 2026-10-12, item 1.4 - employees chose their own clock time.
// Live actions must use the server's time; only an offline replay may
// keep the device's time, and then it is flagged and reviewed.
// Migration 20261013120000.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, openSessionId, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let other: TestOrg;
let siteId: string;
let manager: TestMember;

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600e3).toISOString();
const secondsFromNow = (iso: string) => Math.abs(Date.now() - new Date(iso).getTime()) / 1000;

// clock in with a reported time; offline = sent by the offline queue.
const clockInAt = (member: TestMember, reportedAt: string, offline: boolean) =>
  t.as(member.authId, "select public.clock_in_prosm_time_attendance($1, $2, null, $3, 30.02125, 31.75812, 8, null, null, null, $4) as r", [randomUUID(), siteId, reportedAt, offline]);
const clockOutAt = (member: TestMember, reportedAt: string, offline: boolean) =>
  t.as(member.authId, "select public.clock_out_prosm_time_attendance($1, $2, 30.02125, 31.75812, 8, null, null, $3) as r", [randomUUID(), reportedAt, offline]);

async function employee(name: string): Promise<TestMember> {
  const member = await addMember(t, org, "employee", name);
  await assignToSite(t, siteId, member);
  return member;
}

async function lastEvent(member: TestMember) {
  const [row] = await t.su<{ id: string; occurred_at: string; time_source: string }>(
    "select id, occurred_at::text, time_source from attendance_events where user_id = $1 order by created_at desc limit 1",
    [member.userId],
  );
  return row;
}

const reviewsFor = (member: TestMember) =>
  t.su<{ id: string; action: string; status: string; device_time: string }>("select id, action, status, device_time::text from offline_time_reviews where user_id = $1 order by created_at", [member.userId]);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  other = await createOrg(t, "Orbit");
  siteId = await createSite(t, org, "Tower B");
  manager = await addMember(t, org, "manager", "Nile Manager");
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [siteId, manager.userId]);
  await t.su(
    "insert into user_permission_overrides (user_id, permission_id, is_granted, reason) select $1, id, true, 'test' from permissions where permission_key = 'exceptions.manage'",
    [manager.userId],
  );
});

describe("server time for live attendance (audit 1.4)", () => {
  it("records a live clock-in 20 hours back at the server's time (T10)", async () => {
    const emp = await employee("Backdating Omar");
    expect((await clockInAt(emp, hoursAgo(20), false)).error).toBeNull();
    const event = await lastEvent(emp);
    expect(secondsFromNow(event.occurred_at)).toBeLessThan(60);
    expect(event.time_source).toBe("server");
    expect(await reviewsFor(emp)).toHaveLength(0);
  });

  it("records a live clock-in sent with a time 2 hours ago at the server's time", async () => {
    const emp = await employee("Live Mona");
    expect((await clockInAt(emp, hoursAgo(2), false)).error).toBeNull();
    const [session] = await t.su<{ clock_in_at: string }>("select clock_in_at::text from attendance_sessions where user_id = $1", [emp.userId]);
    expect(secondsFromNow(session.clock_in_at)).toBeLessThan(60);
  });

  it("keeps an offline replay's device time, flags it and opens one pending review", async () => {
    const emp = await employee("Offline Ali");
    const deviceTime = hoursAgo(2);
    expect((await clockInAt(emp, deviceTime, true)).error).toBeNull();
    const event = await lastEvent(emp);
    expect(new Date(event.occurred_at).toISOString()).toBe(deviceTime);
    expect(event.time_source).toBe("device_offline");
    const reviews = await reviewsFor(emp);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ action: "clock_in", status: "pending" });

    // Elapsed time after reconnecting still counts from the real clock-in.
    const [session] = await t.su<{ hours: number }>("select extract(epoch from now() - clock_in_at) / 3600 as hours from attendance_sessions where user_id = $1", [emp.userId]);
    expect(Number(session.hours)).toBeGreaterThan(1.9);
  });

  it("uses the server's time for an offline replay within 2 minutes (no review)", async () => {
    const emp = await employee("Quick Sync Hana");
    expect((await clockInAt(emp, new Date(Date.now() - 60e3).toISOString(), true)).error).toBeNull();
    expect((await lastEvent(emp)).time_source).toBe("server");
    expect(await reviewsFor(emp)).toHaveLength(0);
  });

  it("refuses a replayed time earlier than the last recorded action", async () => {
    const emp = await employee("Rewind Karim");
    expect((await clockInAt(emp, hoursAgo(3), true)).error).toBeNull();
    const result = await clockOutAt(emp, hoursAgo(4), true);
    expect(result.error).toMatch(/OFFLINE TIME IS BEFORE YOUR LAST RECORDED ACTION/);
    expect(await openSessionId(t, emp)).not.toBeNull();
  });

  it("refuses a replayed time on a day of approved leave", async () => {
    const emp = await employee("Leave Sara");
    // Half an hour before today's UTC midnight: yesterday, within the 24-hour window.
    const now = new Date();
    const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 1800e3);
    const day = yesterday.toISOString().slice(0, 10);
    await t.su("insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, status) values ($1, $2, 'annual', $3, $3, 1, 'approved')", [org.id, emp.userId, day]);
    const result = await clockInAt(emp, yesterday.toISOString(), true);
    expect(result.error).toMatch(/APPROVED LEAVE/);
  });

  it("applies the same rule to clock-out and breaks", async () => {
    const emp = await employee("Breaks Youssef");
    expect((await clockInAt(emp, hoursAgo(5), true)).error).toBeNull();
    const sessionId = await openSessionId(t, emp);

    // Live break start sent with an old time: server time.
    expect((await t.as(emp.authId, "select public.start_prosm_time_break($1, $2, $3)", [sessionId, randomUUID(), hoursAgo(1)])).error).toBeNull();
    const [liveBreak] = await t.su<{ id: string; started_at: string; start_time_source: string }>("select id, started_at::text, start_time_source from break_events where user_id = $1", [emp.userId]);
    expect(secondsFromNow(liveBreak.started_at)).toBeLessThan(60);
    expect(liveBreak.start_time_source).toBe("server");
    expect((await t.as(emp.authId, "select public.end_prosm_time_break($1, $2)", [liveBreak.id, randomUUID()])).error).toBeNull();

    // A second user whose break and clock-out were made offline.
    const off = await employee("Offline Breaks Nour");
    expect((await clockInAt(off, hoursAgo(5), true)).error).toBeNull();
    const offSession = await openSessionId(t, off);
    expect((await t.as(off.authId, "select public.start_prosm_time_break($1, $2, $3, true)", [offSession, randomUUID(), hoursAgo(3)])).error).toBeNull();
    const [offBreak] = await t.su<{ id: string }>("select id from break_events where user_id = $1", [off.userId]);
    expect((await t.as(off.authId, "select public.end_prosm_time_break($1, $2, $3, true)", [offBreak.id, randomUUID(), hoursAgo(2.5)])).error).toBeNull();
    expect((await clockOutAt(off, hoursAgo(1), true)).error).toBeNull();

    const [ended] = await t.su<{ start_time_source: string; end_time_source: string }>("select start_time_source, end_time_source from break_events where id = $1", [offBreak.id]);
    expect(ended).toEqual({ start_time_source: "device_offline", end_time_source: "device_offline" });
    expect((await lastEvent(off)).time_source).toBe("device_offline");
    expect((await reviewsFor(off)).map((row) => row.action)).toEqual(["clock_in", "break_start", "break_end", "clock_out"]);
  });

  it("shows the review to the site manager and the owner, not to another organisation, and records the decision", async () => {
    const emp = await employee("Review Laila");
    expect((await clockInAt(emp, hoursAgo(2), true)).error).toBeNull();
    const [review] = await reviewsFor(emp);

    const seen = async (member: TestMember) => (await t.as<{ id: string }>(member.authId, "select id from offline_time_reviews where id = $1", [review.id])).rows ?? [];
    expect(await seen(manager)).toHaveLength(1);
    expect(await seen(org.owner)).toHaveLength(1);
    expect(await seen(emp)).toHaveLength(1);
    expect(await seen(other.owner)).toHaveLength(0);

    expect((await t.as(other.owner.authId, "select public.review_prosm_time_exception('offline_time', $1, 'approved')", [review.id])).error).toMatch(/NOT FOUND/);
    expect((await t.as(manager.authId, "select public.review_prosm_time_exception('offline_time', $1, 'approved', 'ok')", [review.id])).error).toBeNull();
    const [after] = await t.su<{ status: string; reviewed_by: string }>("select status, reviewed_by from offline_time_reviews where id = $1", [review.id]);
    expect(after).toEqual({ status: "approved", reviewed_by: manager.userId });
  });

  it("cannot be written directly by an employee", async () => {
    const emp = await employee("Direct Write Tarek");
    const direct = await t.as(emp.authId, "select public.resolve_prosm_time_reported_time($1, now(), true, null, null)", [emp.userId]);
    expect(direct.error).toMatch(/permission denied/);
    const insert = await t.as(emp.authId, "insert into offline_time_reviews (organization_id, user_id, action, source_table, source_id, device_time) values ($1, $2, 'clock_in', 'attendance_events', $3, now())", [org.id, emp.userId, randomUUID()]);
    expect(insert.error).toMatch(/permission denied|row-level security/);
  });
});
