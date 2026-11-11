// 2026-11-11 (owner): a clock-in with a fake (simulated) location tells the owner at once.
// Migration 20261111160000.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite } from "./support/fixtures";

describe("fake location alerts", () => {
  it("notifies the owner when someone clocks in with a simulated location", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Mock Co");
    const site = await createSite(t, org, "Main");
    const amira = await addMember(t, org, "employee", "Amira");
    await assignToSite(t, site, amira);
    const r = await t.as(amira.authId,
      "select public.clock_in_prosm_time_attendance($1, $2, null, null, 30.0212, 31.7581, 8, null, null, null, false, true)", [randomUUID(), site]);
    expect(r.error).toBeNull();
    const [owner] = await t.su<{ id: string }>("select id from users where organization_id = $1 and is_owner", [org.id]);
    const notes = await t.su<{ data: { kind: string; employeeName: string } }>(
      "select data from notifications where user_id = $1 and type = 'location_plausibility_flag'", [owner.id]);
    expect(notes.map((n) => n.data.kind)).toContain("mock_location");
    expect(notes[0].data.employeeName).toBe("Amira");
  });
});
