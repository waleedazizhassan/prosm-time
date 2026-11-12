// 2026-11-10 (owner): no grace period - lateness counts from the late start (else the shift start); a
// clock-in with no site follows the organisation's optional outside-the-sites hours.
// Migration 20261110200000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite } from "./support/fixtures";

describe("no grace, and hours outside the sites", () => {
  it("has no grace anywhere, and lateness counts from the late start", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Grace Co");
    const site = await createSite(t, org, "Main");
    const [s] = await t.su<{ grace_tolerance_minutes: number }>("select grace_tolerance_minutes from sites where id = $1", [site]);
    expect(s.grace_tolerance_minutes).toBe(0);
    const amira = await addMember(t, org, "employee", "Amira");
    await assignToSite(t, site, amira);
    // a clock-in at 08:20 Cairo time on 2027-03-10 (06:20 UTC)
    await t.su("update sites set timezone = 'Africa/Cairo', shift_start_time = '08:00', late_deduction_start_time = '08:30' where id = $1", [site]);
    await t.su("insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at, clock_out_at) values ($1, $2, $3, 'clocked_out', '2027-03-10 06:20:00+00', '2027-03-10 14:00:00+00')",
      [org.id, amira.userId, site]);
    const late = async () => (await t.su<{ v: boolean }>("select public.prosm_time_late_today($1, '2027-03-10') as v", [amira.userId]))[0].v;
    expect(await late()).toBe(false); // 08:20 is before the late start 08:30
    await t.su("update sites set late_deduction_start_time = null where id = $1", [site]);
    expect(await late()).toBe(true); // no late start: from the shift start 08:00
  });

  it("a day with no site follows the outside-the-sites hours; with none it has no lateness", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Outside Co");
    const omar = await addMember(t, org, "employee", "Omar");
    await t.su("insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at, clock_out_at, manual_location_label) values ($1, $2, null, 'clocked_out', '2027-03-11 07:00:00+00', '2027-03-11 15:00:00+00', 'Client office')",
      [org.id, omar.userId]);
    const day = async () => (await t.su<{ d: { lateMinutes: number } }>("select public.prosm_time_day_summary($1, '2027-03-11') as d", [omar.userId]))[0].d;
    expect(Number((await day()).lateMinutes ?? 0)).toBe(0);

    const set = await t.as(org.owner.authId, "select public.set_prosm_time_no_site_hours('08:00', '16:00', '16:00', '08:15')");
    expect(set.error).toBeNull();
    const [os] = await t.su<{ no_site_late_deduction_start_time: string }>("select no_site_late_deduction_start_time::text from organization_settings where organization_id = $1", [org.id]);
    expect(os.no_site_late_deduction_start_time).toBe("08:15:00");
    expect(Number((await day()).lateMinutes)).toBeGreaterThan(0);

    const employee = await t.as(omar.authId, "select public.set_prosm_time_no_site_hours(null, null, null, null)");
    expect(employee.error).toMatch(/ONLY THE ORGANIZATION OWNER/);
  });
});
