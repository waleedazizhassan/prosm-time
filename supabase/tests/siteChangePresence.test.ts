// v2.3.55 (owner 2026-10-27): after a site change mid-shift the employee is
// tracked against the new site - no "outside the area" while inside it.
// Migration 20261027130000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let siteA: string;
let siteB: string;
let worker: TestMember;

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Move Co");
  siteA = await createSite(t, org, "Ratomag");
  siteB = await createSite(t, org, "Chipsy", { latitude: 30.5, longitude: 31.5 });
  await t.su("update sites set presence_monitoring_enabled = true where id in ($1, $2)", [siteA, siteB]);
  worker = await addMember(t, org, "employee", "Walid");
  await assignToSite(t, siteA, worker);
  await assignToSite(t, siteB, worker);
  expect((await clockIn(t, worker, siteA)).error).toBeNull();
  // the first site's tracking saw them leave
  await t.su("update presence_sessions set outside_since = now() where user_id = $1 and status = 'active'", [worker.userId]);
});

describe("site change and presence", () => {
  it("tracking moves to the new site, and the dashboard no longer shows them outside", async () => {
    const change = await t.as(worker.authId, "select public.change_prosm_time_site(null, $1, 30.5, 31.5, 10)", [siteB]);
    expect(change.error).toBeNull();

    const sessions = await t.su<{ site_id: string; status: string; end_reason: string | null; outside_since: string | null }>(
      "select site_id, status, end_reason, outside_since from presence_sessions where user_id = $1 order by started_at, status desc",
      [worker.userId],
    );
    // the shift's one tracking record now follows the new site, fresh
    expect(sessions).toEqual([expect.objectContaining({ site_id: siteB, status: "active", outside_since: null })]);

    const dash = await t.as<{ d: { presentNow: { userId: string; status: string; siteName: string }[] } }>(
      org.owner.authId,
      "select public.get_prosm_time_manager_dashboard(current_date, current_date, 'org', null, 'Africa/Cairo') as d",
    );
    expect(dash.rows![0].d.presentNow.find((person) => person.userId === worker.userId)).toMatchObject({ status: "in", siteName: "Chipsy" });
  });
});
