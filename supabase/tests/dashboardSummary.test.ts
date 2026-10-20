// Owner 2026-10-20: the dashboard's figures, counted on the server in one read
// over the people the caller is responsible for. Migration 20261020250000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let managerA: TestMember;
let present: TestMember;
let onLeave: TestMember;
let otherSite: TestMember;

interface Summary {
  team: number;
  present: number;
  onBreak: number;
  onLeave: number;
  absent: number;
  waiting: number;
  week: { day: string; minutes: number }[];
}
const summary = async (member: TestMember) => {
  const result = await t.as<{ r: Summary }>(member.authId, "select public.get_prosm_time_dashboard_summary(current_date - extract(dow from current_date)::int, 'UTC') as r");
  if (result.error) throw new Error(result.error);
  return result.rows![0].r;
};

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  const siteA = await createSite(t, org, "Site A");
  const siteB = await createSite(t, org, "Site B", { latitude: 30.3, longitude: 31.9 });
  managerA = await addMember(t, org, "manager", "Mona");
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [siteA, managerA.userId]);
  present = await addMember(t, org, "employee", "Lido");
  onLeave = await addMember(t, org, "employee", "Sara");
  otherSite = await addMember(t, org, "employee", "Omar");
  await assignToSite(t, siteA, present);
  await assignToSite(t, siteA, onLeave);
  await assignToSite(t, siteB, otherSite);
  expect((await clockIn(t, present, siteA)).error).toBeNull();
  await t.su("update attendance_sessions set clock_in_at = now() - interval '2 hours' where user_id = $1", [present.userId]);
  await t.su(
    "insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, status) values ($1, $2, 'annual', current_date, current_date, 1, 'approved')",
    [org.id, onLeave.userId],
  );
  await t.su(
    "insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, status) values ($1, $2, 'annual', current_date + 10, current_date + 10, 1, 'pending')",
    [org.id, present.userId],
  );
});

describe("dashboard summary", () => {
  it("counts the Owner's whole team, never the Owner", async () => {
    const s = await summary(org.owner);
    expect(s).toMatchObject({ team: 4, present: 1, onLeave: 1, absent: 2, waiting: 1 });
    expect(s.week).toHaveLength(7);
    expect(s.week.reduce((sum, d) => sum + d.minutes, 0)).toBeGreaterThanOrEqual(119);
  });

  it("counts only a manager's own sites", async () => {
    const s = await summary(managerA);
    // Mona herself, Lido (present) and Sara (on leave); not Omar at Site B.
    expect(s).toMatchObject({ team: 3, present: 1, onLeave: 1, absent: 1, waiting: 1 });
  });

  it("refuses someone who cannot view attendance", async () => {
    const result = await t.as(present.authId, "select public.get_prosm_time_dashboard_summary(current_date, 'UTC')");
    expect(result.error).toMatch(/ATTENDANCE.VIEW/);
  });
});
