// 2026-11-11 (owner): following a person during the shift is on at every site, always.
// Migration 20261111120000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, createOrg, createSite } from "./support/fixtures";

describe("tracking always on", () => {
  it("is on for every site, cannot be switched off, and a clock-in starts it", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Track Co");
    const site = await createSite(t, org, "Main");
    await t.su("update sites set presence_monitoring_enabled = false where id = $1", [site]);
    const [s] = await t.su<{ on: boolean }>("select presence_monitoring_enabled as on from sites where id = $1", [site]);
    expect(s.on).toBe(true);
    const amira = await addMember(t, org, "employee", "Amira");
    await assignToSite(t, site, amira);
    expect((await clockIn(t, amira, site)).error).toBeNull();
    const rows = await t.su("select 1 from presence_sessions where user_id = $1 and status = 'active'", [amira.userId]);
    expect(rows).toHaveLength(1);
  });
});
