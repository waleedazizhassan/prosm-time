// 2026-11-11 (owner): the phone's background service sends locations with a tracking key; the server
// records them as the app would and says when the shift is over. Migration 20261111140000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, clockOut, createOrg, createSite } from "./support/fixtures";

describe("tracking keys", () => {
  it("records a location for the key's person during the shift, and stops after it", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Key Co");
    const site = await createSite(t, org, "Main");
    const amira = await addMember(t, org, "employee", "Amira");
    await assignToSite(t, site, amira);
    expect((await clockIn(t, amira, site)).error).toBeNull();

    const issued = await t.as<{ k: string }>(amira.authId, "select public.issue_prosm_time_tracking_key() as k");
    expect(issued.error).toBeNull();
    const key = issued.rows![0].k;
    expect(key).toHaveLength(64);

    const send = (k: string, lat = 30.0212, lng = 31.7581) =>
      t.as<{ r: { active: boolean; reason?: string } }>(null, "select public.record_prosm_time_location_by_key($1, $2, $3, 10, null, false) as r", [k, lat, lng]);
    const inside = await send(key);
    expect(inside.error).toBeNull();
    expect(inside.rows![0].r.active).toBe(true);
    const [{ n }] = await t.su<{ n: number }>("select count(*)::int as n from location_samples s where s.user_id = $1", [amira.userId]);
    expect(n).toBeGreaterThanOrEqual(1);

    expect((await send("0".repeat(64))).rows![0].r).toMatchObject({ active: false, reason: "key" });

    expect((await clockOut(t, amira)).error).toBeNull();
    expect((await send(key)).rows![0].r).toMatchObject({ active: false, reason: "no_shift" });
  });

  // owner 2026-11-11: offline points arrive later as history only; fake locations are never recorded
  it("keeps a late location as history, refuses a fake one and tells the managers once", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Fake Co");
    const site = await createSite(t, org, "Main");
    const amira = await addMember(t, org, "employee", "Amira");
    await assignToSite(t, site, amira);
    expect((await clockIn(t, amira, site)).error).toBeNull();
    // the shift began half an hour ago
    await t.su("update presence_sessions set started_at = now() - interval '30 minutes' where user_id = $1", [amira.userId]);
    const key = (await t.as<{ k: string }>(amira.authId, "select public.issue_prosm_time_tracking_key() as k")).rows![0].k;
    const send = (at: string | null, simulated: boolean, lat = 30.0212) =>
      t.as<{ r: Record<string, unknown> }>(null, "select public.record_prosm_time_location_by_key($1, $2, 31.7581, 10, $3::timestamptz, $4) as r", [key, lat, at, simulated]);

    // 10 minutes ago, far outside: history only - no exception
    const late = await send(new Date(Date.now() - 10 * 60_000).toISOString(), false, 30.1);
    expect(late.rows![0].r).toMatchObject({ active: true, stored: "history" });
    expect(await t.su("select 1 from geofence_exceptions where user_id = $1", [amira.userId])).toHaveLength(0);

    // two days ago: not taken
    expect((await send(new Date(Date.now() - 48 * 3600_000).toISOString(), false)).rows![0].r).toMatchObject({ skipped: "old" });

    // fake: refused, the managers told once
    expect((await send(null, true)).rows![0].r).toMatchObject({ rejected: "simulated" });
    expect((await send(null, true)).rows![0].r).toMatchObject({ rejected: "simulated" });
    const flags = await t.su("select 1 from notifications where type = 'location_plausibility_flag' and data ->> 'kind' = 'mock_presence'");
    expect(flags.length).toBeGreaterThanOrEqual(1);
    const [{ n }] = await t.su<{ n: number }>("select count(distinct created_at)::int as n from notifications where type = 'location_plausibility_flag' and data ->> 'kind' = 'mock_presence'");
    expect(n).toBe(1);
  });
});
