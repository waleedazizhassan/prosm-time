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
      t.as<{ r: { active: boolean; reason?: string } }>(null, "select public.record_prosm_time_location_by_key($1, $2, $3, 10, null) as r", [k, lat, lng]);
    const inside = await send(key);
    expect(inside.error).toBeNull();
    expect(inside.rows![0].r.active).toBe(true);
    const [{ n }] = await t.su<{ n: number }>("select count(*)::int as n from location_samples s where s.user_id = $1", [amira.userId]);
    expect(n).toBeGreaterThanOrEqual(1);

    expect((await send("0".repeat(64))).rows![0].r).toMatchObject({ active: false, reason: "key" });

    expect((await clockOut(t, amira)).error).toBeNull();
    expect((await send(key)).rows![0].r).toMatchObject({ active: false, reason: "no_shift" });
  });
});
