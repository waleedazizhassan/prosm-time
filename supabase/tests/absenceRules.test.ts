// 2026-11-11 (owner): absent today counts from the late start; the daily summary lists everyone absent;
// an out-of-area exception's state can be asked by whoever has authority. Migration 20261111100000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, createOrg, createSite } from "./support/fixtures";

describe("absence and exception status", () => {
  it("is absent only once the late start has passed", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Absent Co");
    const site = await createSite(t, org, "Main");
    const amira = await addMember(t, org, "employee", "Amira");
    await assignToSite(t, site, amira);
    const [{ today, weekday }] = await t.su<{ today: string; weekday: number }>(
      "select ((now() at time zone 'Africa/Cairo')::date)::text as today, extract(dow from (now() at time zone 'Africa/Cairo'))::int as weekday");
    // only on a working day (the default week rests on Friday and Saturday)
    if (weekday === 5 || weekday === 6) return;
    await t.su("update sites set timezone = 'Africa/Cairo', shift_start_time = '00:00', late_deduction_start_time = '23:59' where id = $1", [site]);
    const absent = async () => (await t.su<{ v: boolean }>("select public.prosm_time_absent_today($1, $2::date, 'Africa/Cairo') as v", [amira.userId, today]))[0].v;
    expect(await absent()).toBe(false); // the shift started, but lateness has not
    await t.su("update sites set late_deduction_start_time = '00:00' where id = $1", [site]);
    expect(await absent()).toBe(true);
  });

  it("tells the owner an exception still waits for the employee's reason, and tells nobody else", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Exc Co");
    const amira = await addMember(t, org, "employee", "Amira");
    const omar = await addMember(t, org, "employee", "Omar");
    const site = await createSite(t, org, "Main");
    await assignToSite(t, site, amira);
    // a clock-in about 1 km away from the site: an exception waiting for the reason
    const clocked = await clockIn(t, amira, site, { latitude: 30.0302, longitude: 31.7581 });
    expect(clocked.error).toBeNull();
    const [ex] = await t.su<{ id: string }>("select id from geofence_exceptions where user_id = $1", [amira.userId]);
    const ask = async (authId: string) => (await t.as<{ r: { found: boolean; status?: string; employeeName?: string } }>(authId,
      "select public.get_prosm_time_exception_status($1) as r", [ex.id])).rows![0].r;
    expect(await ask(org.owner.authId)).toMatchObject({ found: true, status: "pending_reason", employeeName: "Amira" });
    expect(await ask(omar.authId)).toMatchObject({ found: false });
  });
});
