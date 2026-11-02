// 2026-11-02 (plan stage 3.3): a locked organisation is read-only - its people read,
// nobody changes, and the switch turns the full lock back on.
// Migration 20261102210000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite } from "./support/fixtures";

describe("locked organisation, read-only", () => {
  it("reads, refuses changes, and reopens with the licence", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Paused Co");
    const site = await createSite(t, org, "Yard");
    const worker = await addMember(t, org, "employee", "Worker");
    await assignToSite(t, site, worker);
    await t.su("insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at, clock_out_at) values ($1, $2, $3, 'clocked_out', now() - interval '9 hours', now() - interval '1 hour')", [org.id, worker.userId, site]);
    await t.su("update license_activation_state set expires_at = now() - interval '30 days' where organization_id = $1", [org.id]);

    const status = await t.as<{ s: { locked: boolean; readOnly: boolean } }>(worker.authId, "select public.get_prosm_time_trial_status() as s");
    expect(status.rows![0].s).toMatchObject({ locked: true, readOnly: true });
    const readBack = await t.as(worker.authId, "select id from attendance_sessions");
    expect(readBack.error).toBeNull();
    expect(readBack.rows).toHaveLength(1);
    expect((await t.as(org.owner.authId, "select public.set_prosm_time_overtime_policy(null, null, '{\"minLateMinutes\": 5}'::jsonb)")).error).toMatch(/READ ONLY/);
    expect((await t.as(worker.authId, "select public.clock_in_prosm_time_attendance('k-locked', $1::uuid)", [site])).error).not.toBeNull();
    expect(await t.su("select id from attendance_sessions where status = 'clocked_in'")).toHaveLength(0);

    // a server job still runs
    await t.su("update sites set name = 'By the server' where id = $1", [site]);

    await t.su("update platform_settings set value = 'false'::jsonb where key = 'locked_organizations_read_only'");
    expect((await t.as(worker.authId, "select id from attendance_sessions")).rows ?? []).toHaveLength(0);

    await t.su("update platform_settings set value = 'true'::jsonb where key = 'locked_organizations_read_only'");
    await t.su("update license_activation_state set expires_at = now() + interval '1 year' where organization_id = $1", [org.id]);
    expect((await t.as(org.owner.authId, "select public.set_prosm_time_overtime_policy(null, null, '{\"minLateMinutes\": 5}'::jsonb)")).error).toBeNull();
  });
});
