// Owner 2026-11-13: the "late today" card's window lists today's late people (the card's own rule), whatever
// period is chosen. Migration 20261113180000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let late: TestMember;

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Late Co");
  await t.su("update organization_settings set rest_days = '{}' where organization_id = $1", [org.id]);
  const site = await createSite(t, org, "Main");
  await t.su("update sites set shift_start_time = '00:00', late_deduction_start_time = '00:00', timezone = 'UTC' where id = $1", [site]);
  late = await addMember(t, org, "employee", "Lateef");
  await assignToSite(t, site, late);
  expect((await clockIn(t, late, site)).error).toBeNull();
  await t.su("update attendance_sessions set clock_in_at = greatest(date_trunc('day', now()) + interval '30 minutes', now() - interval '5 minutes') where user_id = $1", [late.userId]);
});

describe("late today", () => {
  it("lists today's late people even when the chosen period is last month", async () => {
    const r = await t.as<{ d: { kpi: { lateToday: number }; lateTodayList: { name: string }[] } }>(org.owner.authId,
      "select public.get_prosm_time_manager_dashboard(current_date - 40, current_date - 35, 'org', null, 'UTC') as d");
    expect(r.error).toBeNull();
    const d = r.rows![0].d;
    expect(d.lateTodayList.length).toBe(d.kpi.lateToday);
    if (d.kpi.lateToday > 0) expect(d.lateTodayList[0].name).toBe("Lateef");
  });
});
