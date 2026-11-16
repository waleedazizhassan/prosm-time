// Phase F round 1 (owner approved 2026-11-16), migration 20261117100000: how leave is decided - direct (as before),
// decentralized, centralized (HR), two-step (manager then HR). Department managers and hr.approve_all_requests are new
// sources of authority; the owner always decides; nobody decides their own request.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let siteManager: TestMember;
let deptManager: TestMember;
let hr: TestMember;
let worker: TestMember;
let loner: TestMember; // no site, no department
let n = 0;

const mode = (m: string) => t.as(org.owner.authId, "select public.set_prosm_time_approval_mode('leave', $1)", [m]);
const leave = async (who: TestMember) => {
  n += 1;
  // a different Monday each time (a working day, never overlapping)
  const [{ id }] = await t.su<{ id: string }>(
    "insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, status) values ($1, $2, 'annual', date '2027-01-04' + ($3::int * 7), date '2027-01-04' + ($3::int * 7), 1, 'pending') returning id",
    [org.id, who.userId, n]);
  return id;
};
const decide = (who: TestMember, id: string, action = "approved") => t.as<{ r: { awaiting?: string } }>(who.authId, `select public.review_prosm_time_leave($1, '${action}', 'ok', null) as r`, [id]);
const state = async (id: string) => (await t.su<{ status: string; approval_step: number }>("select status, approval_step from leave_requests where id = $1", [id]))[0];
const pending = async (who: TestMember) => ((await t.as<{ id: string }>(who.authId, "select id from public.list_prosm_time_pending_leave_requests()")).rows ?? []).map((r) => r.id);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "PhaseF");
  const site = await createSite(t, org, "Plant");
  siteManager = await addMember(t, org, "manager", "SiteBoss");
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, siteManager.userId]);
  deptManager = await addMember(t, org, "manager", "DeptBoss");
  hr = await addMember(t, org, "manager", "HrPerson");
  await t.su("insert into user_permission_overrides (user_id, permission_id, is_granted) select $1, id, true from permissions where permission_key = 'hr.approve_all_requests'", [hr.userId]);
  // leave decisions still need leave.approve (as before); HR needs only hr.approve_all_requests
  await t.su("insert into user_permission_overrides (user_id, permission_id, is_granted) select u, p.id, true from unnest($1::uuid[]) u cross join permissions p where p.permission_key = 'leave.approve' on conflict do nothing", [[siteManager.userId, deptManager.userId]]);
  worker = await addMember(t, org, "employee", "Worker");
  await assignToSite(t, site, worker);
  loner = await addMember(t, org, "employee", "Loner");
  const [{ id: dept }] = await t.su<{ id: string }>("insert into departments (organization_id, name, manager_user_id) values ($1, 'Finance', $2) returning id", [org.id, deptManager.userId]);
  await t.su("update users set department_id = $1 where id = $2", [dept, worker.userId]);
});
beforeEach(async () => { await mode("direct"); });

describe("direct (the default - as before, plus the new sources)", () => {
  it("the site manager, the department manager and HR may decide; the owner always", async () => {
    for (const who of [siteManager, deptManager, hr, org.owner]) {
      const id = await leave(worker);
      expect((await decide(who, id)).error).toBeNull();
      expect((await state(id)).status).toBe("approved");
    }
  });
  it("nobody decides their own request", async () => {
    const id = await leave(hr);
    expect((await decide(hr, id)).error).not.toBeNull();
  });
});

describe("centralized: HR (and the owner)", () => {
  it("the site manager is refused, HR decides; the queue shows it to HR, not to the manager", async () => {
    await mode("centralized");
    const id = await leave(worker);
    expect(await pending(siteManager)).not.toContain(id);
    expect(await pending(hr)).toContain(id);
    expect((await decide(siteManager, id)).error).toMatch(/DO NOT MANAGE|WAITING/);
    expect((await decide(hr, id)).error).toBeNull();
    expect((await state(id)).status).toBe("approved");
  });
});

describe("two_step: the manager, then HR", () => {
  it("the manager's approval hands it to HR; HR completes it; the manager cannot complete it", async () => {
    await mode("two_step");
    const id = await leave(worker);
    expect(await pending(hr)).not.toContain(id);
    const first = await decide(siteManager, id);
    expect(first.error).toBeNull();
    expect(first.rows![0].r.awaiting).toBe("hr");
    expect(await state(id)).toEqual({ status: "pending", approval_step: 2 });
    expect(await pending(siteManager)).not.toContain(id);
    expect(await pending(hr)).toContain(id);
    expect((await decide(deptManager, id)).error).toMatch(/WAITING FOR HUMAN RESOURCES/);
    expect((await decide(hr, id)).error).toBeNull();
    expect((await state(id)).status).toBe("approved");
  });
  it("nobody operational over the person -> it starts at HR", async () => {
    await mode("two_step");
    const id = await leave(loner);
    expect(await pending(hr)).toContain(id);
    expect((await decide(hr, id)).error).toBeNull();
    expect((await state(id)).status).toBe("approved");
  });
  it("a rejection at the first step ends it; the owner decides both steps at once", async () => {
    await mode("two_step");
    const rejected = await leave(worker);
    expect((await decide(siteManager, rejected, "rejected")).error).toBeNull();
    expect((await state(rejected)).status).toBe("rejected");
    const byOwner = await leave(worker);
    expect((await decide(org.owner, byOwner)).error).toBeNull();
    expect((await state(byOwner)).status).toBe("approved");
  });
});

describe("the setting", () => {
  it("only the owner changes it, audited", async () => {
    expect((await t.as(hr.authId, "select public.set_prosm_time_approval_mode('leave', 'centralized')")).error).toMatch(/ONLY THE ORGANIZATION OWNER/);
    expect((await mode("decentralized")).error).toBeNull();
    expect((await t.su("select 1 from audit_logs where action = 'APPROVAL_MODE_CHANGED' and organization_id = $1", [org.id])).length).toBeGreaterThan(0);
  });
});
