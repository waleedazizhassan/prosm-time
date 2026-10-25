// v2.3.43 step 3 (items 7 and 8): the work calendar - public holidays,
// weekly rest days (Friday by default), exceptional days - who may change
// them, and how the timesheet reads them. Migration 20261025120000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let site: string;
let otherSite: string;
let worker: TestMember;
let manager: TestMember;
let otherManager: TestMember;

// A shift on a given Cairo date and hours (Cairo is UTC+2 or +3; the test
// uses the site's own time zone through the database).
async function shift(member: TestMember, siteId: string, date: string, from: string, to: string) {
  await t.su(
    `insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at, clock_out_at)
     values ($1, $2, $3, 'clocked_out', ($4 || ' ' || $5)::timestamp at time zone 'Africa/Cairo', ($4 || ' ' || $6)::timestamp at time zone 'Africa/Cairo')`,
    [org.id, member.userId, siteId, date, from, to],
  );
}

async function timesheet(member: TestMember, from: string, to: string) {
  await t.su("delete from timesheets where user_id = $1", [member.userId]);
  const result = await t.as(org.owner.authId, "select public.generate_prosm_time_timesheet($1, $2, $3)", [member.userId, from, to]);
  expect(result.error).toBeNull();
  const [row] = await t.su<{ worked: number; overtime: number; deduction: number }>(
    "select total_worked_minutes as worked, total_overtime_minutes as overtime, total_deduction_minutes as deduction from timesheets where user_id = $1",
    [member.userId],
  );
  return { worked: Number(row.worked), overtime: Number(row.overtime), deduction: Number(row.deduction) };
}

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Aswan");
  site = await createSite(t, org, "Dam Site");
  otherSite = await createSite(t, org, "Quarry");
  worker = await addMember(t, org, "employee", "Worker One");
  manager = await addMember(t, org, "manager", "Dam Manager");
  otherManager = await addMember(t, org, "manager", "Quarry Manager");
  await assignToSite(t, site, worker);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, manager.userId]);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [otherSite, otherManager.userId]);
  // Overtime after 17:00, late after 08:15 (Cairo).
  await t.su("update sites set timezone = 'Africa/Cairo', overtime_start_time = '17:00', late_deduction_start_time = '08:15' where id = $1", [site]);
});

describe("work calendar (items 7 and 8)", () => {
  it("the defaults: Friday is the weekly rest day, the week starts on Saturday, Cairo time", async () => {
    const [row] = await t.su<{ rest_days: number[]; week_start_day: number; timezone: string }>(
      "select rest_days, week_start_day, timezone from organization_settings where organization_id = $1",
      [org.id],
    );
    expect(row.rest_days).toEqual([5]);
    expect(row.week_start_day).toBe(6);
    expect(row.timezone).toBe("Africa/Cairo");
    const [{ friday, sunday }] = await t.su<{ friday: string; sunday: string }>(
      "select public.prosm_time_day_type($1, $2, '2026-10-23') as friday, public.prosm_time_day_type($1, $2, '2026-10-25') as sunday",
      [worker.userId, site],
    );
    expect(friday).toBe("weekly_rest");
    expect(sunday).toBe("workday");
  });

  it("organisation-wide holidays are the Owner's; a manager adds one for their own site only", async () => {
    expect((await t.as(manager.authId, "select public.save_prosm_time_holiday(null, null, 'Armed Forces Day', '2026-10-06', '2026-10-06')")).error).toMatch(/ORGANISATION-WIDE/);
    expect((await t.as(otherManager.authId, "select public.save_prosm_time_holiday(null, $1, 'Local feast', '2026-11-02', '2026-11-02')", [site])).error).toMatch(/DO NOT MANAGE THIS SITE/);
    expect((await t.as(worker.authId, "select public.save_prosm_time_holiday(null, $1, 'x', '2026-11-02', '2026-11-02')", [site])).error).toMatch(/CALENDAR.MANAGE/);
    expect((await t.as(manager.authId, "select public.save_prosm_time_holiday(null, $1, 'Local feast', '2026-11-02', '2026-11-02')", [site])).error).toBeNull();
    expect((await t.as(org.owner.authId, "select public.save_prosm_time_holiday(null, null, 'Armed Forces Day', '2026-10-06', '2026-10-06')")).error).toBeNull();
    const [{ day }] = await t.su<{ day: string }>("select public.prosm_time_day_type($1, $2, '2026-10-06') as day", [worker.userId, site]);
    expect(day).toBe("public_holiday");
    expect((await t.su("select id from audit_logs where action = 'calendar.holiday_saved'")).length).toBe(2);
  });

  it("a site's own rest days replace the organisation's", async () => {
    expect((await t.as(manager.authId, "select public.set_prosm_time_rest_days($1, null, array[5,6]::smallint[])", [site])).error).toBeNull();
    const [{ saturday }] = await t.su<{ saturday: string }>("select public.prosm_time_day_type($1, $2, '2026-10-24') as saturday", [worker.userId, site]);
    expect(saturday).toBe("weekly_rest");
    expect((await t.as(manager.authId, "select public.set_prosm_time_rest_days($1, null, null)", [site])).error).toBeNull();
    expect((await t.as(manager.authId, "select public.set_prosm_time_rest_days($1, null, array[9]::smallint[])", [site])).error).toMatch(/INVALID WEEKDAYS/);
  });

  it("work on a weekly rest day or a holiday is all overtime, with no late deduction", async () => {
    await shift(worker, site, "2026-10-23", "09:00", "13:00"); // Friday, 4 h, late
    await shift(worker, site, "2026-10-06", "10:00", "12:30"); // holiday, 2.5 h
    const sheet = await timesheet(worker, "2026-10-01", "2026-10-31");
    expect(sheet.worked).toBeCloseTo(390, 0);
    expect(sheet.overtime).toBeCloseTo(390, 0);
    expect(sheet.deduction).toBe(0);
    await t.su("delete from attendance_sessions where user_id = $1", [worker.userId]);
  });

  it("a normal workday: overtime after 17:00 and lateness after 08:15, counted in Cairo time", async () => {
    await shift(worker, site, "2026-10-25", "08:45", "18:30"); // Sunday
    const sheet = await timesheet(worker, "2026-10-25", "2026-10-25");
    expect(sheet.overtime).toBeCloseTo(90, 0);
    expect(sheet.deduction).toBeCloseTo(30, 0);
    await t.su("delete from attendance_sessions where user_id = $1", [worker.userId]);
  });

  it("an exceptional day 'leave at 4 pm, no deduction': overtime starts at 16:00 and nothing is deducted", async () => {
    expect(
      (await t.as(manager.authId, "select public.save_prosm_time_schedule_exception(null, $1, null, null, '2026-10-29', '2026-10-29', null, '16:00', false, true, 'Thursday early leave')", [site])).error,
    ).toBeNull();
    await shift(worker, site, "2026-10-29", "08:45", "16:30");
    const sheet = await timesheet(worker, "2026-10-29", "2026-10-29");
    expect(sheet.deduction).toBe(0);
    expect(sheet.overtime).toBeCloseTo(30, 0);
    expect((await t.su("select id from audit_logs where action = 'calendar.exception_saved'")).length).toBe(1);
  });

  it("an exception needs a reason and one scope; the calendar read returns it", async () => {
    expect((await t.as(manager.authId, "select public.save_prosm_time_schedule_exception(null, $1, null, null, '2026-10-30', '2026-10-30', null, null, true, false, '')", [site])).error).toMatch(/REASON/);
    expect((await t.as(org.owner.authId, "select public.save_prosm_time_schedule_exception(null, $1, null, $2, '2026-10-30', '2026-10-30', null, null, true, false, 'x')", [site, worker.userId])).error).toMatch(/ONE SCOPE/);
    const result = await t.as<{ c: { holidays: unknown[]; exceptions: unknown[] } }>(worker.authId, "select public.get_prosm_time_calendar('2026-10-01', '2026-11-30') as c");
    expect(result.error).toBeNull();
    expect(result.rows?.[0].c.holidays).toHaveLength(2);
    expect(result.rows?.[0].c.exceptions).toHaveLength(1);
  });
});
