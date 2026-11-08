// 2026-11-08 hardening (migration 20261108120000): site scope for shifts and external workers,
// helpers that answered for any organisation, and the action log for changes that skipped it.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let other: TestOrg;
let siteA: string;
let siteB: string;
let otherSite: string;
let managerA: TestMember;
let workerB: TestMember;

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Scope Co");
  other = await createOrg(t, "Elsewhere");
  siteA = await createSite(t, org, "North");
  siteB = await createSite(t, org, "South");
  otherSite = await createSite(t, other, "Far");
  managerA = await addMember(t, org, "manager", "North Manager");
  workerB = await addMember(t, org, "employee", "South Worker");
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [siteA, managerA.userId]);
  await assignToSite(t, siteB, workerB);
  await t.su("insert into shift_assignments (organization_id, user_id, site_id, shift_date, start_time, end_time) values ($1, $2, $3, current_date + 3, '08:00', '16:00')", [org.id, workerB.userId, siteB]);
  await t.su("insert into site_workers (organization_id, site_id, full_name, worker_number) values ($1, $2, 'Contractor B', '900001'), ($1, $3, 'Contractor A', '900002'), ($1, null, 'Unplaced', '900003')", [org.id, siteB, siteA]);
});

describe("site scope", () => {
  it("a manager does not read shifts at a site they do not manage", async () => {
    const seen = await t.as(managerA.authId, "select id from shift_assignments where site_id = $1", [siteB]);
    expect(seen.error).toBeNull();
    expect(seen.rows).toEqual([]);
    const owner = await t.as(org.owner.authId, "select id from shift_assignments where site_id = $1", [siteB]);
    expect(owner.rows!.length).toBe(1);
  });

  it("external workers: their own sites and the unplaced ones only", async () => {
    const seen = await t.as<{ full_name: string }>(managerA.authId, "select full_name from site_workers order by full_name");
    expect(seen.rows!.map((row) => row.full_name)).toEqual(["Contractor A", "Unplaced"]);
  });
});

describe("helpers that answered for any organisation", () => {
  it("cannot probe another organisation's site location or settings", async () => {
    expect((await t.as(managerA.authId, "select public.compute_prosm_time_geofence_check($1, 30, 31, 5)", [otherSite])).error).toMatch(/permission denied/);
    expect((await t.as(managerA.authId, "select public.prosm_time_allowance_basis($1)", [other.id])).error).toMatch(/permission denied/);
    expect((await t.as(managerA.authId, "select public.prosm_time_site_timezone($1, null)", [otherSite])).error).toMatch(/permission denied/);
    const history = await t.as<{ d: string | null }>(managerA.authId, "select public.prosm_time_history_start_date($1) as d", [other.id]);
    expect(history.rows![0].d).toBeNull();
    const own = await t.as<{ d: string | null }>(managerA.authId, "select public.prosm_time_history_start_date($1) as d", [org.id]);
    expect(own.rows![0].d).not.toBeNull();
  });
});

describe("action log", () => {
  it("records a change that did not log itself, with who did it", async () => {
    expect((await t.as(org.owner.authId, "select public.set_prosm_time_overtime_alert_minutes(25)")).error).toBeNull();
    const rows = await t.su<{ actor_user_id: string; action: string }>(
      "select actor_user_id, action from audit_logs where organization_id = $1 and action = 'organization_settings.update'", [org.id]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].actor_user_id).toBe(org.owner.userId);
  });

  it("keeps the delegation context when a delegate acts", async () => {
    const deputy = await addMember(t, org, "supervisor", "Deputy");
    expect((await t.as(org.owner.authId, "select public.grant_prosm_time_owner_authority($1, 'away')", [deputy.userId])).error).toBeNull();
    expect((await t.as(deputy.authId, "select public.set_prosm_time_overtime_alert_minutes(30)")).error).toBeNull();
    const [row] = await t.su<{ context: { onBehalfOf?: string } }>(
      "select context from audit_logs where organization_id = $1 and action = 'organization_settings.update' and actor_user_id = $2", [org.id, deputy.userId]);
    expect(row.context.onBehalfOf).toBe(org.owner.userId);
  });
});
