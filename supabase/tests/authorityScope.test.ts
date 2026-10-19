// Owner 2026-10-18 permission review: a Manager or Supervisor acts only on
// people ranked below them at the sites they manage; the Owner on everyone;
// the read-only role keeps an organisation-wide view. Migration 20261019110000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let siteA: string;
let siteB: string;
let managerA: TestMember;
let supervisorA: TestMember;
let employeeA: TestMember;
let employeeB: TestMember;
let readOnly: TestMember;

async function siteManager(role: string, name: string, siteId: string): Promise<TestMember> {
  const member = await addMember(t, org, role, name);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [siteId, member.userId]);
  return member;
}

const requestLeave = async (member: TestMember) => {
  const result = await t.as(member.authId, "select public.request_prosm_time_leave('annual', current_date + 30, current_date + 31, 'Family')");
  if (result.error) throw new Error(result.error);
  const [row] = await t.su<{ id: string }>("select id from leave_requests where user_id = $1 order by created_at desc limit 1", [member.userId]);
  return row.id;
};
const reviewLeave = (member: TestMember, id: string) => t.as(member.authId, "select public.review_prosm_time_leave($1, 'approved', null)", [id]);
const generate = (member: TestMember, subject: TestMember) =>
  t.as<{ r: { timesheetId: string } }>(member.authId, "select public.generate_prosm_time_timesheet($1, date_trunc('month', current_date)::date, current_date) as r", [subject.userId]);
const timesheetsSeen = async (member: TestMember) =>
  ((await t.as<{ user_id: string }>(member.authId, "select user_id from timesheets")).rows ?? []).map((row) => row.user_id);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  siteA = await createSite(t, org, "Site A");
  siteB = await createSite(t, org, "Site B", { latitude: 30.3, longitude: 31.9 });
  managerA = await siteManager("manager", "Manager A", siteA);
  await siteManager("manager", "Manager B", siteB);
  supervisorA = await siteManager("supervisor", "Supervisor A", siteA);
  employeeA = await addMember(t, org, "employee", "Employee A");
  employeeB = await addMember(t, org, "employee", "Employee B");
  readOnly = await addMember(t, org, "read_only", "Auditor");
  await assignToSite(t, siteA, employeeA);
  await assignToSite(t, siteB, employeeB);
  for (const subject of [employeeA, employeeB]) {
    const result = await generate(org.owner, subject);
    if (result.error) throw new Error(result.error);
  }
});

describe("authority limited to the people a manager manages", () => {
  it("lets a manager generate timesheets only for people at their sites", async () => {
    expect((await generate(managerA, employeeA)).error).toBeNull();
    expect((await generate(managerA, employeeB)).error).toMatch(/NOT AUTHORIZED/);
  });

  it("shows timesheets only of people at the caller's sites (read-only: everyone)", async () => {
    const seen = await timesheetsSeen(supervisorA);
    expect(seen).toContain(employeeA.userId);
    expect(seen).not.toContain(employeeB.userId);
    expect(await timesheetsSeen(readOnly)).toEqual(expect.arrayContaining([employeeA.userId, employeeB.userId]));
  });

  // Leave approval is its own permission since 20261019130000 (Managers and the Owner).
  it("lets a manager review leave only for people below them at their sites", async () => {
    const leaveA = await requestLeave(employeeA);
    const leaveB = await requestLeave(employeeB);
    const queue = ((await t.as<{ user_id: string }>(managerA.authId, "select user_id from public.list_prosm_time_pending_leave_requests()")).rows ?? []).map((row) => row.user_id);
    expect(queue).toEqual([employeeA.userId]);
    expect((await reviewLeave(managerA, leaveB)).error).toMatch(/YOU DO NOT MANAGE THIS EMPLOYEES SITE/);
    expect((await reviewLeave(managerA, leaveA)).error).toBeNull();
    // Their own leave: not theirs to decide.
    const managerLeave = await requestLeave(managerA);
    expect((await reviewLeave(managerA, managerLeave)).error).toMatch(/YOU DO NOT MANAGE THIS EMPLOYEES SITE/);
    expect((await reviewLeave(org.owner, managerLeave)).error).toBeNull();
  });

  it("lets only the site's managers review a flag raised at that site", async () => {
    expect((await clockIn(t, employeeB, siteB, { latitude: 30.3, longitude: 31.9 })).error).toBeNull();
    const [event] = await t.su<{ id: string }>("select id from attendance_events where user_id = $1 and event_type = 'clock_in'", [employeeB.userId]);
    const [flag] = await t.su<{ id: string }>(
      "insert into mock_location_flags (organization_id, user_id, site_id, attendance_event_id, event_type, latitude, longitude, occurred_at) values ($1, $2, $3, $4, 'clock_in', 30.3, 31.9, now()) returning id",
      [org.id, employeeB.userId, siteB, event.id],
    );
    const review = (member: TestMember) => t.as(member.authId, "select public.review_prosm_time_exception('mock_location', $1, 'approved', null)", [flag.id]);
    expect((await review(managerA)).error).toMatch(/YOU DO NOT MANAGE THIS EMPLOYEES SITE/);
    expect((await review(org.owner)).error).toBeNull();
  });
});
