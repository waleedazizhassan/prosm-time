// v2.3.55 (owner 2026-10-27): the company card shows the licence's users
// against the organisation's active people - the Owner's to see (20261027150000). Migration 20261027140000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite } from "./support/fixtures";

describe("seat usage", () => {
  it("counts every active person of the organisation, and nobody else's", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Seats Co");
    const other = await createOrg(t, "Other Co");
    const site = await createSite(t, org, "Main");
    const manager = await addMember(t, org, "manager", "Mona");
    const a = await addMember(t, org, "employee", "A");
    await addMember(t, org, "employee", "B (another site)");
    const gone = await addMember(t, org, "employee", "Left");
    await addMember(t, other, "employee", "Elsewhere");
    await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, manager.userId]);
    await assignToSite(t, site, a);
    await t.su("update users set is_active = false where id = $1", [gone.userId]);
    await t.su("update license_activation_state set max_users = 10 where organization_id = $1", [org.id]);

    const seen = await t.as<{ s: { activeUsers: number; maxUsers: number } }>(org.owner.authId, "select public.get_prosm_time_seat_usage() as s");
    expect(seen.error).toBeNull();
    // the Owner, Mona, A and B - not the one who left, not the other company's
    expect(seen.rows![0].s).toEqual({ activeUsers: 4, maxUsers: 10 });
  });
});
