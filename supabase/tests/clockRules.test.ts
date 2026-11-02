// 2026-11-02 (plan stage 8.2): early-leave grace and rounding of the day's worked
// minutes, on the server, and no change until the owner sets them. Migration 20261102110000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite } from "./support/fixtures";

describe("clock rules", () => {
  it("rounds the worked time and forgives a short early leave, once set", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Rules Co");
    const site = await createSite(t, org, "Yard");
    const worker = await addMember(t, org, "employee", "Worker");
    await assignToSite(t, site, worker);
    await t.su("update sites set timezone = 'Africa/Cairo', shift_end_time = '17:00' where id = $1", [site]);
    await t.su(
      `insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at, clock_out_at)
       values ($1, $2, $3, 'clocked_out', '2026-10-05 09:00'::timestamp at time zone 'Africa/Cairo', '2026-10-05 16:52'::timestamp at time zone 'Africa/Cairo')`,
      [org.id, worker.userId, site],
    );
    const summary = async () => (await t.su<{ s: Record<string, number> }>("select public.prosm_time_day_summary($1, '2026-10-05') as s", [worker.userId]))[0].s;

    const before = await summary();
    expect(Number(before.workedMinutes)).toBe(472);
    expect(Number(before.earlyLeaveMinutes)).toBe(8);

    const set = await t.as(org.owner.authId, "select public.set_prosm_time_overtime_policy(null, null, $1::jsonb)", [JSON.stringify({ minEarlyLeaveMinutes: 10, roundMinutes: 15 })]);
    expect(set.error).toBeNull();
    const after = await summary();
    expect(Number(after.workedMinutes)).toBe(465);
    expect(Number(after.earlyLeaveMinutes)).toBe(0);

    await t.as(org.owner.authId, "select public.set_prosm_time_overtime_policy(null, null, $1::jsonb)", [JSON.stringify({ minLateMinutes: 5 })]);
    expect(Number((await summary()).workedMinutes)).toBe(465);
  });
});
