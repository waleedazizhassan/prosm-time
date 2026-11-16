// Phase F round 2 (owner 2026-11-16), migration 20261117120000: the governance model covers attendance permissions
// and corrections too - centralized (HR), decentralized (operational), combined (manager then HR) - set at once.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let site: string;
let siteManager: TestMember;
let hr: TestMember;
let worker: TestMember;
let n = 0;

const model = (m: string) => t.as(org.owner.authId, "select public.set_prosm_time_governance_model($1)", [m]);
const permission = async () => {
  n += 1;
  const [{ id }] = await t.su<{ id: string }>(
    "insert into attendance_permissions (organization_id, user_id, work_date, kind, reason) values ($1, $2, current_date + $3::int, 'late_arrival', 'doctor') returning id",
    [org.id, worker.userId, n]);
  return id;
};
const correction = async () => {
  n += 1;
  const [{ id: session }] = await t.su<{ id: string }>(
    "insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at, clock_out_at) values ($1, $2, $3, 'clocked_out', now() - ($4::int || ' days')::interval - interval '8 hours', now() - ($4::int || ' days')::interval - interval '1 hour') returning id",
    [org.id, worker.userId, site, n]);
  const [{ id }] = await t.su<{ id: string }>(
    "insert into correction_requests (organization_id, user_id, attendance_session_id, proposed_event_type, proposed_correct_time, reason) values ($1, $2, $3, 'clock_in', now() - ($4::int || ' days')::interval - interval '7 hours', 'forgot') returning id",
    [org.id, worker.userId, session, n]);
  return id;
};
const decidePermission = (who: TestMember, id: string) =>
  t.as<{ r: { awaiting?: string } }>(who.authId, "select public.review_prosm_time_attendance_permission($1, 'approved', true, null, null, 'ok') as r", [id]);
const decideCorrection = (who: TestMember, id: string) =>
  t.as<{ r: { awaiting?: string } }>(who.authId, "select public.review_prosm_time_exception('correction_request', $1, 'approved', 'ok') as r", [id]);
const permissionQueue = async (who: TestMember) =>
  ((await t.as<{ q: { requests: { id: string }[] } }>(who.authId, "select public.list_prosm_time_permission_queue() as q")).rows![0].q.requests ?? []).map((r) => r.id);
const correctionQueue = async (who: TestMember) =>
  ((await t.as<{ q: { id: string }[] }>(who.authId, "select public.list_prosm_time_correction_queue() as q")).rows![0].q ?? []).map((r) => r.id);
const status = async (table: string, id: string) => (await t.su<{ status: string; approval_step: number }>(`select status, approval_step from ${table} where id = $1`, [id]))[0];

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "GovModel");
  site = await createSite(t, org, "Plant");
  siteManager = await addMember(t, org, "manager", "SiteBoss");
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, siteManager.userId]);
  await t.su("insert into user_permission_overrides (user_id, permission_id, is_granted) select $1, id, true from permissions where permission_key in ('attendance.manage_permissions', 'exceptions.manage') on conflict do nothing", [siteManager.userId]);
  hr = await addMember(t, org, "manager", "HrPerson");
  await t.su("insert into user_permission_overrides (user_id, permission_id, is_granted) select $1, id, true from permissions where permission_key = 'hr.approve_all_requests'", [hr.userId]);
  worker = await addMember(t, org, "employee", "Worker");
  await assignToSite(t, site, worker);
});

describe("the governance model", () => {
  it("sets all three kinds at once, owner only, audited", async () => {
    expect((await model("centralized")).error).toBeNull();
    const [{ m }] = await t.su<{ m: Record<string, string> }>("select jsonb_object_agg(request_kind, mode) as m from approval_modes where organization_id = $1", [org.id]);
    expect(m).toEqual({ leave: "centralized", permission: "centralized", correction: "centralized" });
    expect((await t.as(hr.authId, "select public.set_prosm_time_governance_model('direct')")).error).toMatch(/ONLY THE ORGANIZATION OWNER/);
    expect(await t.su("select 1 from audit_logs where action = 'GOVERNANCE_MODEL_CHANGED' and organization_id = $1", [org.id])).toHaveLength(1);
  });

  it("direct: the site manager decides permissions and corrections as before", async () => {
    await model("direct");
    const p = await permission();
    expect(await permissionQueue(siteManager)).toContain(p);
    expect((await decidePermission(siteManager, p)).error).toBeNull();
    const c = await correction();
    expect(await correctionQueue(siteManager)).toContain(c);
    expect((await decideCorrection(siteManager, c)).error).toBeNull();
    expect((await status("correction_requests", c)).status).toBe("approved");
  });

  it("centralized: only HR decides; the site manager no longer sees them", async () => {
    await model("centralized");
    const p = await permission();
    const c = await correction();
    expect(await permissionQueue(siteManager)).not.toContain(p);
    expect(await correctionQueue(siteManager)).not.toContain(c);
    expect((await decidePermission(siteManager, p)).error).not.toBeNull();
    expect((await decideCorrection(siteManager, c)).error).not.toBeNull();
    expect(await permissionQueue(hr)).toContain(p);
    expect(await correctionQueue(hr)).toContain(c);
    expect((await decidePermission(hr, p)).error).toBeNull();
    expect((await decideCorrection(hr, c)).error).toBeNull();
    expect((await status("attendance_permissions", p)).status).toBe("approved");
    expect((await status("correction_requests", c)).status).toBe("approved");
  });

  it("decentralized: the operational side decides; HR does not while there is a manager", async () => {
    await model("decentralized");
    const p = await permission();
    expect(await permissionQueue(hr)).not.toContain(p);
    expect((await decidePermission(hr, p)).error).not.toBeNull();
    expect((await decidePermission(siteManager, p)).error).toBeNull();
  });

  it("combined (two steps): the manager approves, then HR", async () => {
    await model("two_step");
    const p = await permission();
    const first = await decidePermission(siteManager, p);
    expect(first.error).toBeNull();
    expect(first.rows![0].r.awaiting).toBe("hr");
    expect(await status("attendance_permissions", p)).toEqual({ status: "pending", approval_step: 2 });
    expect(await permissionQueue(siteManager)).not.toContain(p);
    expect((await decidePermission(hr, p)).error).toBeNull();
    expect((await status("attendance_permissions", p)).status).toBe("approved");

    const c = await correction();
    expect((await decideCorrection(siteManager, c)).rows![0].r.awaiting).toBe("hr");
    expect((await decideCorrection(siteManager, c)).error).toMatch(/WAITING FOR HUMAN RESOURCES/);
    expect(await correctionQueue(hr)).toContain(c);
    expect((await decideCorrection(hr, c)).error).toBeNull();
    expect((await status("correction_requests", c)).status).toBe("approved");
  });
});
