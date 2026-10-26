// v2.3.43 step 17 (items 5, 4): the manager dashboard read - scope (Owner:
// organisation; Manager: their sites), live snapshot, priorities, sites with
// external workers apart, cost only with payroll.view_cost, no invented
// comparison. Migration 20261025240000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let siteA: string;
let siteB: string;
let manager: TestMember;
let a1: TestMember;
let b1: TestMember;

type Dash = {
  teamSize: number;
  canViewCost: boolean;
  kpi: { presentNow: number; estimatedCost: number | null; previous: unknown };
  presentNow: { userId: string; status: string }[];
  sites: { id: string; present: number; external: { presentNow: number; contractors: { name: string; present: number }[] } | null; cost: number | null }[];
  sos: unknown[];
  priorities: Record<string, number>;
};
const today = () => new Date().toISOString().slice(0, 10);
const dash = async (member: TestMember, scope = "org") => {
  const result = await t.as<{ d: Dash }>(member.authId, "select public.get_prosm_time_manager_dashboard($1, $1, $2, null, 'Africa/Cairo') as d", [today(), scope]);
  if (result.error) throw new Error(result.error);
  return result.rows![0].d;
};

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Minia");
  siteA = await createSite(t, org, "Site A");
  siteB = await createSite(t, org, "Site B", { latitude: 30.5, longitude: 31.5 });
  manager = await addMember(t, org, "manager", "A Manager");
  a1 = await addMember(t, org, "employee", "A One");
  b1 = await addMember(t, org, "employee", "B One");
  await assignToSite(t, siteA, a1);
  await assignToSite(t, siteB, b1);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [siteA, manager.userId]);
  expect((await clockIn(t, a1, siteA)).error).toBeNull();
  expect((await clockIn(t, b1, siteB, { latitude: 30.5, longitude: 31.5 })).error).toBeNull();
  const [worker] = await t.su<{ id: string }>(
    "insert into site_workers (organization_id, site_id, full_name, worker_number, contractor_name) values ($1, $2, 'Hired Hand', '123456', 'Al Nour') returning id",
    [org.id, siteA],
  );
  await t.su("insert into site_worker_attendance (organization_id, site_worker_id, site_id, clock_in_at, clock_in_latitude, clock_in_longitude) values ($1, $2, $3, now(), 30.02, 31.75)", [org.id, worker.id, siteA]);
  await t.su(
    "insert into sos_alerts (organization_id, user_id, attendance_session_id, site_id, status) select organization_id, user_id, id, site_id, 'active' from attendance_sessions where user_id = $1",
    [a1.userId],
  );
});

describe("manager dashboard", () => {
  it("the Owner sees the organisation, with cost", async () => {
    const d = await dash(org.owner);
    expect(d.teamSize).toBe(3);
    expect(d.kpi.presentNow).toBe(2);
    expect(d.canViewCost).toBe(true);
    expect(d.kpi.estimatedCost).not.toBeNull();
    expect(d.sites).toHaveLength(3); // with the organisation's starter site
  });

  it("a Manager sees only their site, no cost, external workers apart", async () => {
    const d = await dash(manager, "mine");
    expect(d.presentNow.map((p) => p.userId)).toEqual([a1.userId]);
    expect(d.canViewCost).toBe(false);
    expect(d.kpi.estimatedCost).toBeNull();
    expect(d.sites.map((s) => s.id)).toEqual([siteA]);
    expect(d.sites[0].cost).toBeNull();
    expect(d.sites[0].external?.presentNow).toBe(1);
    expect(d.sites[0].external?.contractors).toEqual([{ name: "Al Nour", present: 1, today: 1 }]);
    expect(d.kpi.presentNow).toBe(1);
  });

  it("an active SOS shows until acknowledged; no comparison without a previous period", async () => {
    const d = await dash(manager, "mine");
    expect(d.sos).toHaveLength(1);
    expect(d.kpi.previous).toBeNull();
  });

  it("an employee cannot open it", async () => {
    await expect(dash(a1)).rejects.toThrow(/DASHBOARD.VIEW/);
  });

  it("the widget layout is saved per person", async () => {
    expect((await t.as(manager.authId, "select public.save_prosm_time_dashboard_layout('{\"hidden\":[\"audit\"]}'::jsonb)")).error).toBeNull();
    const rows = await t.as<{ layout: { hidden: string[] } }>(manager.authId, "select layout from dashboard_preferences");
    expect(rows.rows?.[0].layout.hidden).toEqual(["audit"]);
  });

  it("sos.acknowledge lets a site lead mark the SOS handled, only at their site", async () => {
    const lead = await addMember(t, org, "employee", "Site Lead");
    await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [siteA, lead.userId]);
    const [alert] = await t.su<{ id: string }>("select id from sos_alerts where user_id = $1 and status = 'active'", [a1.userId]);
    const resolve = () => t.as(lead.authId, "select public.resolve_prosm_time_sos_alert($1, 'on my way')", [alert.id]);
    expect((await resolve()).error).toMatch(/AUTHORITY REQUIRED/);
    await t.su(
      "insert into user_permission_overrides (user_id, permission_id, is_granted, reason) select $1, id, true, 'test' from permissions where permission_key = 'sos.acknowledge'",
      [lead.userId],
    );
    expect((await resolve()).error).toBeNull();
    const [row] = await t.su<{ status: string }>("select status from sos_alerts where id = $1", [alert.id]);
    expect(row.status).toBe("resolved");
  });

  it("the same hours add up in the figures, the sites table and the chart (step 21 audit)", async () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const session = (user: string, site: string | null, from: string, to: string) =>
      t.su("insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at, clock_out_at) values ($1, $2, $3, 'clocked_out', $4, $5)", [org.id, user, site, from, to]);
    await session(a1.userId, siteA, `${yesterday}T06:00:00Z`, `${yesterday}T10:00:00Z`);
    await session(b1.userId, siteB, `${yesterday}T07:00:00Z`, `${yesterday}T09:30:00Z`);
    await session(manager.userId, null, `${yesterday}T08:00:00Z`, `${yesterday}T09:00:00Z`);
    const result = await t.as<{ d: { kpi: { workedMinutes: number }; sites: { workedMinutes: number }[]; chart: { workedMinutes: number }[] } }>(
      org.owner.authId,
      "select public.get_prosm_time_manager_dashboard($1, $1, 'org', null, 'Africa/Cairo') as d",
      [yesterday],
    );
    expect(result.error).toBeNull();
    const d = result.rows![0].d;
    const sites = d.sites.reduce((sum, site) => sum + Number(site.workedMinutes), 0);
    const chart = d.chart.reduce((sum, day) => sum + Number(day.workedMinutes), 0);
    expect(Number(d.kpi.workedMinutes)).toBeGreaterThanOrEqual(390);
    expect(chart).toBe(Number(d.kpi.workedMinutes));
    // the sites table covers work at a site; the hour recorded with no site is the only difference
    expect(Number(d.kpi.workedMinutes) - sites).toBe(60);
  });
});
