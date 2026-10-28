// v2.3.59 (owner 2026-10-28: "why must I be assigned to a site to clock in
// there or change my site to it?"): any active site of the organisation,
// assigned or not; the site's own rules still apply. Migration 20261028140000.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, createOrg, createSite } from "./support/fixtures";

describe("clock-in and site change without a site assignment", () => {
  it("lets a person clock in at, and change to, a site they are not assigned to, from anywhere", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Open Sites Co");
    const worker = await addMember(t, org, "employee", "Worker");
    const first = await createSite(t, org, "First");
    const second = await createSite(t, org, "Second", { latitude: 30.2, longitude: 31.5 });

    // far from the site (a laptop's rough location) and not assigned
    const result = await clockIn(t, worker, first, { latitude: 29.0, longitude: 30.0 });
    expect(result.error).toBeNull();
    // the work area is still checked and recorded
    const [event] = await t.su<{ within_geofence: boolean }>("select within_geofence from attendance_events where user_id = $1 and event_type = 'clock_in'", [worker.userId]);
    expect(event.within_geofence).toBe(false);

    const change = await t.as(worker.authId, "select public.change_prosm_time_site(null, $1, 29.0, 30.0, 20, null, $2)", [second, randomUUID()]);
    expect(change.error).toBeNull();
    const [session] = await t.su<{ site_id: string }>("select site_id from attendance_sessions where user_id = $1 and status = 'clocked_in'", [worker.userId]);
    expect(session.site_id).toBe(second);
  });

  it("offers every active site of the organisation in the clock-in list, the person's own first", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "List Co");
    const other = await createOrg(t, "Elsewhere Co");
    const worker = await addMember(t, org, "employee", "Worker");
    await createSite(t, org, "Alpha");
    const mine = await createSite(t, org, "Zulu");
    const closed = await createSite(t, org, "Closed");
    await t.su("update sites set is_active = false where id = $1", [closed]);
    await createSite(t, other, "Foreign");
    await assignToSite(t, mine, worker);

    const list = await t.as<{ name: string }>(worker.authId, "select name from public.list_prosm_time_clock_in_sites()");
    expect(list.rows!.map((row) => row.name)).toEqual(["Zulu", "Alpha", "List Co main site"]);
  });

  it("still refuses a site that blocks clock-in outside its area, and another organisation's site", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Blocking Co");
    const other = await createOrg(t, "Other Co");
    const worker = await addMember(t, org, "employee", "Worker");
    const blocking = await createSite(t, org, "Blocking");
    await t.su("update sites set outside_zone_policy = 'BLOCK' where id = $1", [blocking]);
    const foreign = await createSite(t, other, "Foreign");

    expect((await clockIn(t, worker, blocking, { latitude: 29.0, longitude: 30.0 })).error).toMatch(/CLOCK_IN_OUTSIDE_AREA_CONTACT_MANAGER/);
    expect((await clockIn(t, worker, foreign)).error).toMatch(/SITE NOT FOUND/);
    // inside the blocking site's area it is fine
    expect((await clockIn(t, worker, blocking)).error).toBeNull();
  });
});
