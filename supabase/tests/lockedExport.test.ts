// 2026-11-02 (plan stage 3.3): the owner of a locked organisation reads attendance
// out, nobody else does, and the lock holds. Migration 20261102160000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, createOrg, createSite } from "./support/fixtures";

const read = "select * from public.export_prosm_time_locked_attendance()";

describe("locked organisation export", () => {
  it("is for the owner, only once locked, and the lock itself holds", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Locked Co");
    const site = await createSite(t, org, "Yard");
    const worker = await addMember(t, org, "employee", "Worker");
    await t.su(
      "insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at, clock_out_at) values ($1, $2, $3, 'clocked_out', now() - interval '2 hours', now() - interval '1 hour')",
      [org.id, worker.userId, site],
    );

    expect((await t.as(org.owner.authId, read)).error).toMatch(/NOT LOCKED/);
    await t.su("update license_activation_state set expires_at = now() - interval '30 days' where organization_id = $1", [org.id]);

    const { rows, error } = await t.as<{ employee: string }>(org.owner.authId, read);
    expect(error).toBeNull();
    expect(rows!.map((row) => row.employee)).toEqual(["Worker"]);
    expect((await t.as(worker.authId, read)).error).toMatch(/ONLY THE OWNER/);
    expect((await t.as(org.owner.authId, "select id from attendance_sessions")).rows ?? []).toHaveLength(0);
  });
});
