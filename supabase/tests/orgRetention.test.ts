// 2026-11-01 (plan stage 7.1): the purge really deletes, an organisation can only
// shorten retention, and each deletion is logged. Migration 20261101130000.
import { describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, type TestMember } from "./support/fixtures";

const sample = async (t: TestDatabase, member: TestMember, orgId: string, ageDays: number) => {
  const [site] = await t.su<{ id: string }>("select id from sites where organization_id = $1 limit 1", [orgId]);
  const [attendance] = await t.su<{ id: string }>(
    "insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at, clock_out_at) values ($1, $2, $3, 'clocked_out', now() - interval '1 hour', now()) returning id",
    [orgId, member.userId, site.id],
  );
  const [session] = await t.su<{ id: string }>(
    "insert into presence_sessions (organization_id, attendance_session_id, user_id, site_id, status, started_at) values ($1, $2, $3, $4, 'ended', now()) returning id",
    [orgId, attendance.id, member.userId, site.id],
  );
  await t.su(
    "insert into location_samples (presence_session_id, user_id, latitude, longitude, captured_at) values ($1, $2, 30, 31, now() - make_interval(days => $3))",
    [session.id, member.userId, ageDays],
  );
};
const count = async (t: TestDatabase, member: TestMember) =>
  (await t.su<{ n: number }>("select count(*)::int as n from location_samples where user_id = $1", [member.userId]))[0].n;

describe("organisation retention", () => {
  it("defaults to 30 days and a shorter period removes old points, with a log", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Keep Co");
    const worker = await addMember(t, org, "employee", "Worker");
    await sample(t, worker, org.id, 10);
    await sample(t, worker, org.id, 1);
    await t.su("select public.purge_prosm_time_expired_location_samples()");
    expect(await count(t, worker)).toBe(2);

    expect((await t.as(org.owner.authId, "select public.set_prosm_time_retention(7, 30)")).error).toBeNull();
    await t.su("select public.purge_prosm_time_expired_location_samples()");
    expect(await count(t, worker)).toBe(1);

    const log = await t.as<{ kind: string; deleted_count: number }>(org.owner.authId, "select kind, deleted_count from data_deletion_log");
    expect(log.rows).toEqual([{ kind: "location_samples", deleted_count: 1 }]);
  });

  it("deletes a sample past its 30 days with no setting changed", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Default Co");
    const worker = await addMember(t, org, "employee", "Worker");
    await sample(t, worker, org.id, 1);
    await t.su("update location_samples set retention_expires_at = now() - interval '1 minute' where user_id = $1", [worker.userId]);
    await t.su("select public.purge_prosm_time_expired_location_samples()");
    expect(await count(t, worker)).toBe(0);
  });

  it("is the owner's, and cannot go past the policy's periods", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Limit Co");
    const worker = await addMember(t, org, "employee", "Worker");
    expect((await t.as(worker.authId, "select public.set_prosm_time_retention(7, 7)")).error).toMatch(/ONLY THE OWNER/);
    expect((await t.as(org.owner.authId, "select public.set_prosm_time_retention(31, 90)")).error).toMatch(/INVALID RETENTION/);
    expect((await t.as(org.owner.authId, "select public.set_prosm_time_retention(30, 91)")).error).toMatch(/INVALID RETENTION/);
  });
});
