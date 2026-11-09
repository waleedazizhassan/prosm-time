// Owner 2026-11-04: "Grant all" - a person gets the owner's whole authority (permissions,
// owner-only actions, notifications and emails) and is back to normal once it is withdrawn.
// Migration 20261104150000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, clockOut, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let site: string;
let mona: TestMember;
let omar: TestMember;

const ownerOnly = (member: TestMember) => t.as(member.authId, "select public.set_prosm_time_overtime_alert_minutes(20)");
const permissions = async (member: TestMember) =>
  (await t.as<{ p: string[] }>(member.authId, "select public.get_prosm_time_effective_permissions() as p")).rows![0].p ?? [];

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Delta");
  site = await createSite(t, org, "Capital");
  mona = await addMember(t, org, "supervisor", "Mona");
  omar = await addMember(t, org, "employee", "Omar");
  await assignToSite(t, site, mona);
});

describe("the owner's authority", () => {
  it("is the owner's alone to grant, with a reason", async () => {
    expect((await t.as(mona.authId, "select public.grant_prosm_time_owner_authority($1, 'try')", [omar.userId])).error).toMatch(/ONLY THE OWNER/);
    expect((await t.as(org.owner.authId, "select public.grant_prosm_time_owner_authority($1, '')", [mona.userId])).error).toMatch(/REASON/);
    expect(await ownerOnly(mona).then((r) => r.error)).toMatch(/ONLY THE OWNER/);
  });

  it("gives every permission and every owner-only action", async () => {
    const before = (await permissions(mona)).length;
    expect((await t.as(org.owner.authId, "select public.grant_prosm_time_owner_authority($1, 'travelling for a month')", [mona.userId])).error).toBeNull();
    const all = (await t.su<{ n: number }>("select count(*)::int as n from permissions"))[0].n;
    expect((await permissions(mona)).length).toBe(all);
    expect(all).toBeGreaterThan(before);
    expect((await ownerOnly(mona)).error).toBeNull();
    // ...but not the owner's own grant
    expect((await t.as(mona.authId, "select public.grant_prosm_time_owner_authority($1, 'x')", [omar.userId])).error).toMatch(/ONLY THE OWNER/);
    const [log] = await t.su<{ reason: string }>("select reason from audit_logs where action = 'OWNER_AUTHORITY_GRANTED' and subject_user_id = $1", [mona.userId]);
    expect(log.reason).toBe("travelling for a month");
  });

  it("keeps the person an employee: they still clock in", async () => {
    expect((await clockIn(t, mona, site)).error).toBeNull();
    expect((await clockOut(t, mona)).error).toBeNull();
  });

  it("copies what reaches the owner to the person holding the authority", async () => {
    await t.su("select public.create_prosm_time_notification($1, $2, 'daily_digest', 'normal', 'Yesterday', 'Summary', null, null, '{}'::jsonb)", [org.id, org.owner.userId]);
    const copies = await t.su<{ n: number }>("select count(*)::int as n from notifications where user_id = $1 and type = 'daily_digest' and data ? 'ownerCopyOf'", [mona.userId]);
    expect(copies[0].n).toBe(1);
  });

  it("puts everything back once withdrawn", async () => {
    expect((await t.as(org.owner.authId, "select public.revoke_prosm_time_owner_authority($1, 'back from travel')", [mona.userId])).error).toBeNull();
    expect((await ownerOnly(mona)).error).toMatch(/ONLY THE OWNER/);
    expect((await permissions(mona)).includes("permissions.assign")).toBe(false);
    await t.su("select public.create_prosm_time_notification($1, $2, 'daily_digest', 'normal', 'Today', 'Summary', null, null, '{}'::jsonb)", [org.id, org.owner.userId]);
    const copies = await t.su<{ n: number }>("select count(*)::int as n from notifications where user_id = $1 and type = 'daily_digest'", [mona.userId]);
    expect(copies[0].n).toBe(1);
    const told = await t.su<{ n: number }>("select count(*)::int as n from notifications where user_id = $1 and type in ('owner_authority_granted', 'owner_authority_revoked')", [mona.userId]);
    expect(told[0].n).toBe(2);
  });
});
