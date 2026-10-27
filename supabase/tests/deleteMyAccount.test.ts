// v2.3.55 (owner 2026-10-27, Google Play): a person deletes their own
// account - personal data goes, the work records stay anonymised; never the
// Owner's account, never while clocked in. Migration 20261027200000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, createOrg, createSite } from "./support/fixtures";

describe("deleting one's own account", () => {
  it("removes what identifies them, keeps the anonymised work records, and tells the Owner", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Delete Co");
    const site = await createSite(t, org, "Main");
    const worker = await addMember(t, org, "employee", "Walid Worker");
    await assignToSite(t, site, worker);
    expect((await clockIn(t, worker, site)).error).toBeNull();

    // clocked in: not yet
    const busy = await t.as<{ p: { authorized: boolean; reason: string } }>(worker.authId, "select public.prepare_prosm_time_self_deletion() as p");
    expect(busy.rows![0].p).toMatchObject({ authorized: false, reason: "clocked_in" });
    await t.su("update attendance_sessions set status = 'clocked_out', clock_out_at = now() where user_id = $1", [worker.userId]);
    await t.su("insert into push_devices (organization_id, user_id, token, platform) values ($1, $2, repeat('x', 40), 'android')", [org.id, worker.userId]);

    const ready = await t.as<{ p: { authorized: boolean; userId: string } }>(worker.authId, "select public.prepare_prosm_time_self_deletion() as p");
    expect(ready.rows![0].p).toMatchObject({ authorized: true, userId: worker.userId });
    // only the service role runs the deletion
    expect((await t.as(worker.authId, "select public.anonymize_prosm_time_user($1)", [worker.userId])).error).toMatch(/permission denied/);
    await t.su("select public.anonymize_prosm_time_user($1)", [worker.userId]);

    const [user] = await t.su<{ full_name: string; email: string; is_active: boolean }>("select full_name, email, is_active from users where id = $1", [worker.userId]);
    expect(user.full_name).toMatch(/^Deleted user/);
    expect(user.email).toMatch(/@deleted\.invalid$/);
    expect(user.is_active).toBe(false);
    const [counts] = await t.su<{ sessions: number; devices: number }>(
      "select (select count(*)::int from attendance_sessions where user_id = $1) as sessions, (select count(*)::int from push_devices where user_id = $1) as devices",
      [worker.userId],
    );
    expect(counts).toEqual({ sessions: 1, devices: 0 });
    const [told] = await t.su<{ n: number }>("select count(*)::int as n from notifications where user_id = $1 and data ->> 'kind' = 'account_deleted'", [org.owner.userId]);
    expect(told.n).toBe(1);
  });

  it("the Owner's account is never deleted this way", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Owner Co");
    const result = await t.as<{ p: { authorized: boolean; reason: string } }>(org.owner.authId, "select public.prepare_prosm_time_self_deletion() as p");
    expect(result.rows![0].p).toEqual({ authorized: false, reason: "owner" });
    await expect(t.su("select public.anonymize_prosm_time_user($1)", [org.owner.userId])).rejects.toThrow(/OWNER ACCOUNT/);
  });
});
