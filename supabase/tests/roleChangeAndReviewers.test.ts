// 2026-11-09 spec B-01 and B-04 (migration 20261109200000).
// B-01: changing a role raises and lowers permissions in the database at once, takes site management
// away below manager, returns the remaining direct grants, is audited, and is refused for oneself,
// for the owner, and above the caller's own rank.
// B-04: the leave reviewer list shows only eligible people from real data - a manager of another
// site never; a delegate appears while the delegation is active and disappears when it ends; the
// server refuses anyone else.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let siteA: string;
let siteB: string;
let worker: TestMember;
let managerA: TestMember;
let managerB: TestMember;
let deputy: TestMember;

async function ok<T>(result: Promise<{ rows: T[] | null; error: string | null }>): Promise<T> {
  const { rows, error } = await result;
  if (error) throw new Error(error);
  return rows![0];
}
const owner = (sql: string, params: unknown[] = []) => t.as(org.owner.authId, sql, params);
const has = async (m: TestMember, key: string) => (await t.su<{ ok: boolean }>("select public.prosm_time_user_has_permission_internal($1, $2) as ok", [m.userId, key]))[0].ok;
const reviewers = async (m: TestMember) => (await ok<{ r: { id: string }[] }>(t.as(m.authId, "select public.list_prosm_time_leave_reviewers() as r"))).r.map((r) => r.id);

beforeAll(async () => {
  t = await buildDatabase();
  expect(t.failures).toEqual([]);
  org = await createOrg(t, "Roles Co");
  siteA = await createSite(t, org, "A");
  siteB = await createSite(t, org, "B");
  worker = await addMember(t, org, "employee", "Worker");
  managerA = await addMember(t, org, "manager", "Manager A");
  managerB = await addMember(t, org, "manager", "Manager B");
  deputy = await addMember(t, org, "employee", "Deputy");
  await assignToSite(t, siteA, worker);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager'), ($3, $4, 'manager')", [siteA, managerA.userId, siteB, managerB.userId]);
});

describe("B-01 changing a role", () => {
  it("raises the permissions at once and is audited", async () => {
    expect(await has(worker, "leave.approve")).toBe(false);
    const r = await ok<{ r: { from: string; to: string } }>(owner("select public.change_prosm_time_user_role($1, 'manager', 'promoted') as r", [worker.userId]));
    expect(r.r).toMatchObject({ from: "employee", to: "manager" });
    // the unified rule: a manager's site-scoped permissions start once they manage a site
    expect(await has(worker, "leave.approve")).toBe(false);
    await t.su("update site_assignments set role_at_site = 'manager' where user_id = $1", [worker.userId]);
    expect(await has(worker, "leave.approve")).toBe(true);
    expect(await t.su("select id from audit_logs where action = 'USER_ROLE_CHANGED' and subject_user_id = $1", [worker.userId])).toHaveLength(1);
  });

  it("lowers them again, takes site management away, and lists the direct grants left", async () => {
    await ok(owner("select public.set_prosm_time_user_permission_override($1, 'reports.export', true, 'kept for review')", [worker.userId]));
    const r = await ok<{ r: { managedSitesRemoved: number; directGrants: { permission: string }[] } }>(owner("select public.change_prosm_time_user_role($1, 'employee', 'back to employee') as r", [worker.userId]));
    expect(r.r.managedSitesRemoved).toBe(1);
    expect(r.r.directGrants.map((g) => g.permission)).toContain("reports.export");
    expect(await has(worker, "leave.approve")).toBe(false);
    expect(await t.su("select 1 from site_assignments where user_id = $1 and role_at_site = 'manager'", [worker.userId])).toHaveLength(0);
  });

  it("is refused for oneself, for the owner, without a reason, and above one's own rank", async () => {
    expect((await t.as(managerA.authId, "select public.change_prosm_time_user_role($1, 'supervisor', 'self')", [managerA.userId])).error).toMatch(/OWN ROLE/);
    expect((await t.as(managerA.authId, "select public.change_prosm_time_user_role($1, 'employee', 'demote owner')", [org.owner.userId])).error).toMatch(/OWNER/);
    expect((await owner("select public.change_prosm_time_user_role($1, 'supervisor', '')", [worker.userId])).error).toMatch(/REASON/);
    expect((await t.as(managerA.authId, "select public.change_prosm_time_user_role($1, 'supervisor', 'no grant')", [worker.userId])).error).toMatch(/PERMISSIONS.ASSIGN/);
    await ok(owner("select public.set_prosm_time_user_permission_override($1, 'permissions.assign', true, 'may change roles')", [managerA.userId]));
    expect((await t.as(managerA.authId, "select public.change_prosm_time_user_role($1, 'manager', 'too high')", [worker.userId])).error).toMatch(/BELOW YOUR OWN/);
    expect((await t.as(managerA.authId, "select public.change_prosm_time_user_role($1, 'supervisor', 'team lead')", [worker.userId])).error).toBeNull();
  });
});

describe("B-04 leave reviewers", () => {
  it("offers the worker's own site manager and the owner, never another site's manager", async () => {
    const list = await reviewers(worker);
    expect(list).toContain(managerA.userId);
    expect(list).toContain(org.owner.userId);
    expect(list).not.toContain(managerB.userId);
  });

  it("shows a delegate while the delegation is active and drops them when it ends", async () => {
    expect(await reviewers(worker)).not.toContain(deputy.userId);
    await ok(owner("select public.grant_prosm_time_owner_authority($1, 'away for a week', now() - interval '1 minute', now() + interval '7 days', 'partial', array['leave.approve'])", [deputy.userId]));
    expect(await reviewers(worker)).toContain(deputy.userId);
    await t.su("update owner_delegations set ends_at = now() - interval '1 second' where user_id = $1", [deputy.userId]);
    expect(await reviewers(worker)).not.toContain(deputy.userId);
  });

  it("the server refuses a reviewer who is not on the list", async () => {
    const result = await t.as(worker.authId, "select public.request_prosm_time_leave('annual', current_date + 30, current_date + 31, null, null, $1)", [managerB.userId]);
    expect(result.error).toMatch(/REVIEWER|NOT ALLOWED|CHOOSE/i);
  });
});
