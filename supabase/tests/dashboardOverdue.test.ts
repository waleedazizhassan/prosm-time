// v2.3.55 (owner 2026-10-27): the dashboard lists who is still clocked in an
// hour or more after their shift ended. Migration 20261027160000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let site: string;
let late: TestMember;
let justEnded: TestMember;
let working: TestMember;
let forgotten: TestMember; // 2026-11-08 B-06: no shift, no site end time, open since yesterday
let freshNoShift: TestMember;

const tz = "public.prosm_time_site_timezone($2, $1)";
const shift = (member: TestMember, startMinutesFromNow: number, endMinutesFromNow: number) =>
  t.su(
    `insert into shift_assignments (organization_id, user_id, site_id, shift_date, start_time, end_time)
     values ($1, $3, $2, ((now() + make_interval(mins => $4)) at time zone ${tz})::date,
             ((now() + make_interval(mins => $4)) at time zone ${tz})::time(0),
             ((now() + make_interval(mins => $5)) at time zone ${tz})::time(0))`,
    [org.id, site, member.userId, startMinutesFromNow, endMinutesFromNow],
  );
const clockedInSince = (member: TestMember, minutesAgo: number) =>
  t.su("insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at) values ($1, $2, $3, 'clocked_in', now() - make_interval(mins => $4))", [
    org.id,
    member.userId,
    site,
    minutesAgo,
  ]);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Overdue Co");
  site = await createSite(t, org, "Main");
  late = await addMember(t, org, "employee", "Still Here");
  justEnded = await addMember(t, org, "employee", "Just Ended");
  working = await addMember(t, org, "employee", "Mid Shift");
  forgotten = await addMember(t, org, "employee", "Forgot Yesterday");
  freshNoShift = await addMember(t, org, "employee", "No Shift Today");
  for (const member of [late, justEnded, working, forgotten, freshNoShift]) await assignToSite(t, site, member);
  await t.su("update sites set shift_end_time = null where id = $1", [site]);
  // ended 2 hours ago / 20 minutes ago / ends in 3 hours
  await shift(late, -600, -120);
  await clockedInSince(late, 600);
  await shift(justEnded, -480, -20);
  await clockedInSince(justEnded, 480);
  await shift(working, -120, 180);
  await clockedInSince(working, 120);
  await clockedInSince(forgotten, 30 * 60);
  await clockedInSince(freshNoShift, 30);
});

describe("didn't clock out", () => {
  it("lists only those an hour or more past their shift's end", async () => {
    const result = await t.as<{ d: { overdue: { userId: string; overdueMinutes: number; siteName: string }[] } }>(
      org.owner.authId,
      "select public.get_prosm_time_manager_dashboard(current_date, current_date, 'org', null, 'Africa/Cairo') as d",
    );
    expect(result.error).toBeNull();
    const overdue = result.rows![0].d.overdue;
    const mine = overdue.filter((row) => row.userId !== forgotten.userId);
    expect(mine.map((row) => row.userId)).toEqual([late.userId]);
    expect(mine[0].overdueMinutes).toBeGreaterThanOrEqual(119);
    expect(mine[0].siteName).toBe("Main");
  });

  it("also lists a session left open from an earlier day where no end time is known (B-06)", async () => {
    const result = await t.as<{ d: { overdue: { userId: string; endedAt: string }[] } }>(
      org.owner.authId,
      "select public.get_prosm_time_manager_dashboard(current_date, current_date, 'org', null, 'Africa/Cairo') as d",
    );
    const ids = result.rows![0].d.overdue.map((row) => row.userId);
    expect(ids).toContain(forgotten.userId);
    expect(ids).not.toContain(freshNoShift.userId);
  });
});
