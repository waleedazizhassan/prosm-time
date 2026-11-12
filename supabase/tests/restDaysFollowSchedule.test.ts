// Owner 2026-11-11: Friday is not a fixed rest day - the site's or the shift's schedule decides. Lateness
// counts on the person's work day (Friday included), never on their rest day; no clock-in on a rest day or
// a recorded holiday is rest, not absence. Migration 20261111240000.
import { describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestOrg } from "./support/fixtures";

const FRIDAY = "2026-10-02";
const late = async (t: TestDatabase, userId: string, day: string) =>
  Number((await t.su<{ d: { lateMinutes: number } }>("select public.prosm_time_day_summary($1, $2) as d", [userId, day]))[0].d.lateMinutes);
const absent = async (t: TestDatabase, userId: string, day: string) =>
  (await t.su<{ a: boolean }>("select public.prosm_time_absent_today($1, $2, 'Africa/Cairo') as a", [userId, day]))[0].a;
const clockInLate = (t: TestDatabase, org: TestOrg, userId: string, site: string, day: string) =>
  t.su("insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at, clock_out_at) values ($1, $2, $3, 'clocked_out', $4, $5)",
    [org.id, userId, site, `${day} 08:30:00 Africa/Cairo`, `${day} 16:00:00 Africa/Cairo`]); // 30 minutes after 08:00 Cairo

describe("rest days follow the schedule, not a fixed Friday", () => {
  it("counts lateness on Friday where Friday is a work day, and never where it is the rest day", async () => {
    const t = await buildDatabase();
    expect(t.failures).toEqual([]);
    const org = await createOrg(t, "Week Co");
    const fridayOff = await createSite(t, org, "Friday off");
    const saturdayOff = await createSite(t, org, "Saturday off");
    await t.su("update sites set timezone = 'Africa/Cairo', shift_start_time = '08:00', late_deduction_start_time = '08:00' where organization_id = $1", [org.id]);
    await t.su("update sites set rest_days = '{5}' where id = $1", [fridayOff]);
    await t.su("update sites set rest_days = '{6}' where id = $1", [saturdayOff]);
    const ali = await addMember(t, org, "employee", "Ali");
    const mona = await addMember(t, org, "employee", "Mona");
    await assignToSite(t, fridayOff, ali);
    await assignToSite(t, saturdayOff, mona);

    // Friday is Mona's work day (her site rests on Saturday): lateness counts
    await clockInLate(t, org, mona.userId, saturdayOff, FRIDAY);
    expect(await late(t, mona.userId, FRIDAY)).toBe(30);
    // Friday is Ali's rest day: no lateness
    await clockInLate(t, org, ali.userId, fridayOff, FRIDAY);
    expect(await late(t, ali.userId, FRIDAY)).toBe(0);
  });

  it("a shift scheduled on the site's rest day makes it a work day; no clock-in on a rest day or a holiday is rest", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Shift Co");
    const site = await createSite(t, org, "Main");
    await t.su("update sites set timezone = 'Africa/Cairo', shift_start_time = '08:00', late_deduction_start_time = '08:00', rest_days = '{5}' where id = $1", [site]);
    const sami = await addMember(t, org, "employee", "Sami");
    const hana = await addMember(t, org, "employee", "Hana");
    for (const m of [sami, hana]) {
      await assignToSite(t, site, m);
      await t.su("update users set created_at = '2026-01-01' where id = $1", [m.userId]);
    }
    // Sami is scheduled on Friday: his work day - lateness counts, and missing it would be absence
    await t.su("insert into shift_assignments (organization_id, user_id, site_id, shift_date, start_time, end_time) values ($1, $2, $3, $4, '08:00', '16:00')",
      [org.id, sami.userId, site, FRIDAY]);
    expect(await absent(t, sami.userId, FRIDAY)).toBe(true);
    await clockInLate(t, org, sami.userId, site, FRIDAY);
    expect(await late(t, sami.userId, FRIDAY)).toBe(30);
    // Hana has no shift and the site rests on Friday: not clocking in is rest, not absence
    expect(await absent(t, hana.userId, FRIDAY)).toBe(false);
    // a recorded holiday on a work day: no clock-in is rest too
    await t.su("insert into public_holidays (organization_id, name, start_date, end_date) values ($1, 'Holiday', '2026-10-06', '2026-10-06')", [org.id]);
    expect(await absent(t, hana.userId, "2026-10-06")).toBe(false);
    // an ordinary work day with no clock-in is absence
    expect(await absent(t, hana.userId, "2026-10-07")).toBe(true);
  });
});
