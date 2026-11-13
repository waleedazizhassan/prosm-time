// Owner 2026-11-13: "I gave HR full permissions, then took them back - but they still work." Every way of
// granting must be undone by taking back: the owner's authority (full or chosen), a single permission given on
// top of the role, and one the role brings that is taken away for this person.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let hr: TestMember;

const effective = async (member: TestMember) => {
  const r = await t.as<{ p: string[] | null }>(member.authId, "select public.get_prosm_time_effective_permissions() as p");
  if (r.error) throw new Error(r.error);
  return r.rows![0].p ?? [];
};
const owner = (sql: string, params: unknown[]) => t.as(org.owner.authId, sql, params);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Revoke Co");
  hr = await addMember(t, org, "employee", "Hana HR");
});

describe("taking permissions back", () => {
  it("the owner's full authority, granted then withdrawn, leaves nothing behind", async () => {
    const before = await effective(hr);
    expect(before).not.toContain("exceptions.manage");
    expect((await owner("select public.grant_prosm_time_owner_authority($1, 'cover')", [hr.userId])).error).toBeNull();
    expect(await effective(hr)).toContain("exceptions.manage");
    expect((await owner("select public.revoke_prosm_time_owner_authority($1, 'back')", [hr.userId])).error).toBeNull();
    expect((await effective(hr)).sort()).toEqual(before.sort());
  });

  it("chosen permissions, granted then withdrawn, leave nothing behind", async () => {
    const before = await effective(hr);
    expect((await owner("select public.grant_prosm_time_owner_authority($1, 'cover', null, null, 'partial', array['leave.approve', 'attendance.view'])", [hr.userId])).error).toBeNull();
    expect(await effective(hr)).toContain("leave.approve");
    expect((await owner("select public.revoke_prosm_time_owner_authority($1, 'back')", [hr.userId])).error).toBeNull();
    expect((await effective(hr)).sort()).toEqual(before.sort());
  });

  it("a permission given on top of the role, then cleared, is gone", async () => {
    expect((await owner("select public.set_prosm_time_user_permission_override($1, 'hr.manage', true, 'hr')", [hr.userId])).error).toBeNull();
    expect(await effective(hr)).toContain("hr.manage");
    expect((await owner("select public.clear_prosm_time_user_permission_override($1, 'hr.manage', 'back')", [hr.userId])).error).toBeNull();
    expect(await effective(hr)).not.toContain("hr.manage");
  });

  it("a permission the role brings can be taken away from this person", async () => {
    const viewer = await addMember(t, org, "read_only", "Vera Viewer");
    const own = "attendance.view";
    expect(await effective(viewer)).toContain(own);
    expect((await owner("select public.set_prosm_time_user_permission_override($1, $2, false, 'not for her')", [viewer.userId, own])).error).toBeNull();
    expect(await effective(viewer)).not.toContain(own);
    const r = await t.as<{ ok: boolean }>(viewer.authId, "select public.prosm_time_user_has_permission_internal(public.current_prosm_time_user_id(), $1) as ok", [own]);
    expect(r.rows?.[0]?.ok ?? false).toBe(false);
  });

  it("every change is in the audit log", async () => {
    const [row] = await t.su<{ n: number }>("select count(*)::int as n from audit_logs where organization_id = $1 and subject_user_id = $2", [org.id, hr.userId]);
    expect(row.n).toBeGreaterThanOrEqual(4);
  });
});

describe("who may change permissions (owner 2026-11-13 governance)", () => {
  it("a site manager changes only supervisors at their sites, never themselves or a peer, and passes on only what they hold", async () => {
    const site = await createSite(t, org, "Gov Site", { latitude: 30.6, longitude: 31.6 });
    const lead = await addMember(t, org, "manager", "Lina Lead");
    const peer = await addMember(t, org, "manager", "Peter Peer");
    const sup = await addMember(t, org, "supervisor", "Sami Sup");
    await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, lead.userId]);
    await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, peer.userId]);
    await assignToSite(t, site, sup);
    const as = (sql: string, params: unknown[]) => t.as(lead.authId, sql, params);
    expect((await as("select public.set_prosm_time_user_permission_override($1, 'audit.view', true, 'me')", [lead.userId])).error).toMatch(/YOUR OWN PERMISSIONS|SUPERVISORS/);
    expect((await as("select public.set_prosm_time_user_permission_override($1, 'audit.view', true, 'peer')", [peer.userId])).error).toMatch(/BELOW YOU|SUPERVISORS/);
    const held = await effective(lead);
    const missing = ["payroll.approve", "audit.view", "hr.manage", "payroll.manage_settings"].find((k) => !held.includes(k))!;
    expect((await as("select public.set_prosm_time_user_permission_override($1, $2, true, 'x')", [sup.userId, missing])).error).toMatch(/THEY HOLD/);
  });
});
