// Owner 2026-10-18: a shift with no site belongs to its nearest site's
// managers (and the Owner): SOS, notifications, visibility and the People
// list. Migration 20261018130000.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let near: string;
let far: string;
let nearManager: TestMember;
let farManager: TestMember;
let walker: TestMember;

async function siteManager(name: string, siteId: string): Promise<TestMember> {
  const member = await addMember(t, org, "manager", name);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [siteId, member.userId]);
  return member;
}

const sessionOf = async (member: TestMember) =>
  (await t.su<{ id: string; responsible_site_id: string }>("select id, responsible_site_id from attendance_sessions where user_id = $1 and status = 'clocked_in'", [member.userId]))[0];
const seesSession = async (viewer: TestMember, sessionId: string) =>
  ((await t.as(viewer.authId, "select id from attendance_sessions where id = $1", [sessionId])).rows ?? []).length === 1;
const seesInPeople = async (viewer: TestMember, member: TestMember) =>
  ((await t.as<{ id: string }>(viewer.authId, "select id from public.list_prosm_time_visible_members()")).rows ?? []).some((row) => row.id === member.userId);
const sosNotified = async (member: TestMember) =>
  (await t.su<{ n: number }>("select count(*)::int as n from notifications where user_id = $1 and type = 'sos_alert'", [member.userId]))[0].n;

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  near = await createSite(t, org, "Factory 10th of Ramadan", { latitude: 30.2961, longitude: 31.7458 });
  far = await createSite(t, org, "Tower B Cairo", { latitude: 30.0444, longitude: 31.2357 });
  nearManager = await siteManager("Factory Manager", near);
  farManager = await siteManager("Cairo Manager", far);
  walker = await addMember(t, org, "employee", "Omar Hassan");
  // Clocks in with no site, about 1 km from the factory.
  const result = await t.as(walker.authId, "select public.clock_in_prosm_time_attendance($1, null, null, null, 30.305, 31.745, 8, 'Supplier visit') as r", [randomUUID()]);
  if (result.error) throw new Error(result.error);
});

describe("a shift with no site belongs to its nearest site", () => {
  it("records the nearest site as responsible", async () => {
    expect((await sessionOf(walker)).responsible_site_id).toBe(near);
  });

  it("lets that site's manager - not another site's - see the shift and the person, as if assigned", async () => {
    const { id } = await sessionOf(walker);
    expect(await seesSession(nearManager, id)).toBe(true);
    expect(await seesSession(farManager, id)).toBe(false);
    expect(await seesInPeople(nearManager, walker)).toBe(true);
    expect(await seesInPeople(farManager, walker)).toBe(false);
  });

  it("sends the SOS to that site's manager and the Owner; the alert keeps the workplace the person wrote", async () => {
    const { id } = await sessionOf(walker);
    expect((await t.as(walker.authId, "select public.trigger_prosm_time_shift_sos_alert($1, 30.305, 31.745, 8)", [id])).error).toBeNull();
    expect(await sosNotified(nearManager)).toBe(1);
    expect(await sosNotified(org.owner)).toBe(1);
    expect(await sosNotified(farManager)).toBe(0);
    const [alert] = await t.su<{ site_id: string; site_name: string }>("select site_id, site_name from sos_alerts where user_id = $1", [walker.userId]);
    expect(alert).toEqual({ site_id: near, site_name: "Supplier visit" });
  });

  it("shows a manager the exceptions found during a shift (not only at clock-in or clock-out)", async () => {
    const monitored = await createSite(t, org, "Port Said Yard", { latitude: 31.2653, longitude: 32.3019, presenceMonitoring: true });
    const yardManager = await siteManager("Yard Manager", monitored);
    const emp = await addMember(t, org, "employee", "Mona Elsayed");
    await assignToSite(t, monitored, emp);
    expect((await clockIn(t, emp, monitored, { latitude: 31.2653, longitude: 32.3019 })).error).toBeNull();
    const [presence] = await t.su<{ id: string }>("select id from presence_sessions where user_id = $1", [emp.userId]);
    expect((await t.as(emp.authId, "select public.record_prosm_time_presence_sample($1, 31.29, 32.33, 8)", [presence.id])).error).toBeNull();
    const seen = await t.as(yardManager.authId, "select id from geofence_exceptions where user_id = $1", [emp.userId]);
    expect(seen.rows).toHaveLength(1);
  });
});
