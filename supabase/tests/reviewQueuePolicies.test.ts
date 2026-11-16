// QA-004 (2026-11-16) - the review queue's row policies on geofence_exceptions and correction_requests evaluated a
// session subquery and the caller's whole permission list for every row of every organisation; a site manager hit
// the 8 s statement limit live. Migration 20261116110000: the organisation is checked first and the caller's
// details once per query. The same people see the same rows - checked here - and another organisation's rows no
// longer cost the reader anything.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, clockOut, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let a: TestOrg;
let b: TestOrg;
let manager: TestMember;
let employee: TestMember;
let elsewhere: TestMember;
let viewer: TestMember;
let bManager: TestMember;
const FOREIGN_ROWS = 3000;

const shift = async (member: TestMember, site: string) => {
  expect((await clockIn(t, member, site)).error).toBeNull();
  expect((await clockOut(t, member)).error).toBeNull();
  const [row] = await t.su<{ session: string; event: string }>(
    "select s.id as session, e.id as event from attendance_sessions s join attendance_events e on e.session_id = s.id where s.user_id = $1 order by e.occurred_at limit 1",
    [member.userId],
  );
  return row;
};
const exception = (org: string, user: string, event: string) =>
  t.su("insert into geofence_exceptions (organization_id, user_id, attendance_event_id, distance_meters, status) values ($1, $2, $3, 250, 'pending_review')", [org, user, event]);
const correction = (org: string, user: string, session: string, status = "pending") =>
  t.su("insert into correction_requests (organization_id, user_id, attendance_session_id, proposed_event_type, proposed_correct_time, reason, status) values ($1, $2, $3, 'clock_in', now() - interval '2 hours', 'Forgot', $4)", [org, user, session, status]);
const seen = async (who: TestMember, table: string) =>
  ((await t.as<{ user_id: string }>(who.authId, `select user_id from ${table}`)).rows ?? []).map((r) => r.user_id).sort();

beforeAll(async () => {
  t = await buildDatabase();
  a = await createOrg(t, "QueueA");
  const main = await createSite(t, a, "Main");
  const other = await createSite(t, a, "Other");
  manager = await addMember(t, a, "manager", "Mona");
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [main, manager.userId]);
  employee = await addMember(t, a, "employee", "Amr");
  await assignToSite(t, main, employee);
  elsewhere = await addMember(t, a, "employee", "Karim");
  await assignToSite(t, other, elsewhere);
  viewer = await addMember(t, a, "read_only", "Vera");
  const e1 = await shift(employee, main);
  const e2 = await shift(elsewhere, other);
  await exception(a.id, employee.userId, e1.event);
  await exception(a.id, elsewhere.userId, e2.event);
  await correction(a.id, employee.userId, e1.session);
  await correction(a.id, elsewhere.userId, e2.session);

  // another organisation with many rows the readers above must never see - nor pay for
  b = await createOrg(t, "QueueB");
  const bSite = await createSite(t, b, "B Main");
  bManager = await addMember(t, b, "manager", "Bassem");
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [bSite, bManager.userId]);
  const bWorker = await addMember(t, b, "employee", "Basma");
  await assignToSite(t, bSite, bWorker);
  const bShift = await shift(bWorker, bSite);
  await t.su(
    `insert into geofence_exceptions (organization_id, user_id, attendance_event_id, distance_meters, status)
     select $1, $2, $3, 300, 'pending_review' from generate_series(1, ${FOREIGN_ROWS})`, [b.id, bWorker.userId, bShift.event]);
  await t.su(
    `insert into correction_requests (organization_id, user_id, attendance_session_id, proposed_event_type, proposed_correct_time, reason, status)
     select $1, $2, $3, 'clock_in', now() - interval '3 hours', 'old', 'rejected' from generate_series(1, ${FOREIGN_ROWS})`, [b.id, bWorker.userId, bShift.session]);
}, 300_000);

describe("the same people see the same queue rows", () => {
  for (const table of ["geofence_exceptions", "correction_requests"]) {
    it(`${table}: the person their own, the site manager their site, owner and viewer the organisation, nobody another organisation`, async () => {
      expect(await seen(employee, table)).toEqual([employee.userId]);
      expect(await seen(manager, table)).toEqual([employee.userId]);
      expect(await seen(a.owner, table)).toEqual([employee.userId, elsewhere.userId].sort());
      expect(await seen(viewer, table)).toEqual([employee.userId, elsewhere.userId].sort());
      expect((await seen(bManager, table)).every((id) => id !== employee.userId && id !== elsewhere.userId)).toBe(true);
    });
  }
});

describe("another organisation's rows cost the reader nothing", () => {
  it(`a site manager reads both tables quickly with ${FOREIGN_ROWS} rows of another organisation in each`, async () => {
    const started = Date.now();
    for (let i = 0; i < 3; i++) {
      expect((await t.as(manager.authId, "select count(*) from geofence_exceptions where status = 'pending_review'")).error).toBeNull();
      expect((await t.as(manager.authId, "select count(*) from correction_requests where status = 'pending'")).error).toBeNull();
    }
    const perRound = (Date.now() - started) / 3;
    console.log(`review-queue read, ${FOREIGN_ROWS} foreign rows per table: ${Math.round(perRound)} ms per round`);
    expect(perRound).toBeLessThan(1500);
  });
});
