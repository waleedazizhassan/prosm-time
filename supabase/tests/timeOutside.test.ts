// Owner 2026-10-18: one reason request per time outside the work area.
// Migration 20261018100000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let siteId: string;

const INSIDE = { latitude: 30.02125, longitude: 31.75812 };
const OUTSIDE = { latitude: 30.04, longitude: 31.78 }; // about 3 km away

async function employee(name: string): Promise<TestMember> {
  const member = await addMember(t, org, "employee", name);
  await assignToSite(t, siteId, member);
  return member;
}

const presenceId = async (member: TestMember) =>
  (await t.su<{ id: string }>("select id from presence_sessions where user_id = $1 and status = 'active'", [member.userId]))[0]?.id;
const sample = async (member: TestMember, at: { latitude: number; longitude: number }) => {
  const result = await t.as(member.authId, "select public.record_prosm_time_presence_sample($1, $2, $3, 8)", [await presenceId(member), at.latitude, at.longitude]);
  if (result.error) throw new Error(result.error);
};
const exceptions = async (member: TestMember) =>
  (await t.su<{ n: number }>("select count(*)::int as n from geofence_exceptions where user_id = $1", [member.userId]))[0].n;
// Samples are minutes apart in real life; keep the timeline ordered in the test.
const later = (member: TestMember) =>
  t.su("update geofence_exceptions set created_at = created_at - interval '10 minutes' where user_id = $1", [member.userId]).then(() =>
    t.su("update presence_sessions set outside_since = outside_since - interval '10 minutes', started_at = started_at - interval '10 minutes' where user_id = $1", [member.userId]),
  );

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  siteId = await createSite(t, org, "Tower B", { presenceMonitoring: true });
});

describe("one reason request per time outside", () => {
  it("asks once while the person stays outside - even after a review - and again only after coming back", async () => {
    const emp = await employee("Omar Hassan");
    expect((await clockIn(t, emp, siteId, INSIDE)).error).toBeNull();
    await sample(emp, INSIDE);
    await later(emp);

    await sample(emp, OUTSIDE);
    expect(await exceptions(emp)).toBe(1);
    await sample(emp, OUTSIDE);
    expect(await exceptions(emp)).toBe(1);

    await t.su("update geofence_exceptions set status = 'resolved' where user_id = $1", [emp.userId]);
    await sample(emp, OUTSIDE);
    expect(await exceptions(emp)).toBe(1);

    await sample(emp, INSIDE);
    await later(emp);
    await sample(emp, OUTSIDE);
    expect(await exceptions(emp)).toBe(2);
  });

  it("uses the clock-in's request when the shift starts outside, and covers a clock-out from the same place", async () => {
    const emp = await employee("Mona Elsayed");
    expect((await clockIn(t, emp, siteId, OUTSIDE)).error).toBeNull();
    expect(await exceptions(emp)).toBe(1);
    await sample(emp, OUTSIDE);
    expect(await exceptions(emp)).toBe(1);

    expect((await t.as(emp.authId, "select public.clock_out_prosm_time_attendance(gen_random_uuid()::text, null, $1, $2, 8)", [OUTSIDE.latitude, OUTSIDE.longitude])).error).toBeNull();
    expect(await exceptions(emp)).toBe(1);
  });

  it("still records a clock-out outside when the person was inside before", async () => {
    const emp = await employee("Ali Kamal");
    expect((await clockIn(t, emp, siteId, INSIDE)).error).toBeNull();
    await sample(emp, INSIDE);
    expect(await exceptions(emp)).toBe(0);
    expect((await t.as(emp.authId, "select public.clock_out_prosm_time_attendance(gen_random_uuid()::text, null, $1, $2, 8)", [OUTSIDE.latitude, OUTSIDE.longitude])).error).toBeNull();
    expect(await exceptions(emp)).toBe(1);
  });
});
