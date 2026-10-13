// Audit 2026-10-12, item 2.4 - fake-GPS detection. Migration 20261013180000.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let siteId: string;
let manager: TestMember;

const today = () => new Date().toISOString().slice(0, 10);
const clockInWith = (member: TestMember, isMock: boolean | null) =>
  t.as(member.authId, "select public.clock_in_prosm_time_attendance($1, $2, null, null, 30.02125, 31.75812, 8, null, null, null, false, $3) as r", [randomUUID(), siteId, isMock]);
const clockOutWith = (member: TestMember, isMock: boolean | null) =>
  t.as(member.authId, "select public.clock_out_prosm_time_attendance($1, null, 30.02125, 31.75812, 8, null, null, false, $2) as r", [randomUUID(), isMock]);
const flags = (member: TestMember) =>
  t.su<{ id: string; event_type: string; status: string }>("select id, event_type, status from mock_location_flags where user_id = $1 order by created_at", [member.userId]);

async function employee(name: string): Promise<TestMember> {
  const member = await addMember(t, org, "employee", name);
  await assignToSite(t, siteId, member);
  return member;
}

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  siteId = await createSite(t, org, "Tower B");
  manager = await addMember(t, org, "manager", "Site Manager");
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [siteId, manager.userId]);
  await t.su(
    "insert into user_permission_overrides (user_id, permission_id, is_granted, reason) select $1, id, true, 'test' from permissions where permission_key = 'exceptions.manage'",
    [manager.userId],
  );
});

describe("fake-GPS detection (audit 2.4)", () => {
  it("records a simulated location without blocking, for the managers to review", async () => {
    const emp = await employee("Mock Omar");
    expect((await clockInWith(emp, true)).error).toBeNull();
    expect((await clockOutWith(emp, true)).error).toBeNull();
    expect((await flags(emp)).map((row) => [row.event_type, row.status])).toEqual([
      ["clock_in", "pending_review"],
      ["clock_out", "pending_review"],
    ]);
    const [event] = await t.su<{ is_mock_location: boolean }>("select is_mock_location from attendance_events where user_id = $1 and event_type = 'clock_in'", [emp.userId]);
    expect(event.is_mock_location).toBe(true);
  });

  it("records nothing for a real or unknown location", async () => {
    const real = await employee("Real Mona");
    expect((await clockInWith(real, false)).error).toBeNull();
    const unknown = await employee("Browser Ali");
    expect((await clockInWith(unknown, null)).error).toBeNull();
    expect(await flags(real)).toHaveLength(0);
    expect(await flags(unknown)).toHaveLength(0);
  });

  it("shows it to the site manager, in the Location Violations report, and records the review", async () => {
    const emp = await employee("Mock Karim");
    expect((await clockInWith(emp, true)).error).toBeNull();
    const [flag] = await flags(emp);

    const seen = await t.as<{ id: string }>(manager.authId, "select id from mock_location_flags where id = $1", [flag.id]);
    expect(seen.rows).toHaveLength(1);
    const report = await t.as<{ flag_id: string; violation_type: string }>(manager.authId, "select flag_id, violation_type from public.list_prosm_time_report_location_violations($1, $1)", [today()]);
    expect(report.rows?.some((row) => row.flag_id === flag.id && row.violation_type === "mock_location")).toBe(true);

    expect((await t.as(manager.authId, "select public.review_prosm_time_exception('mock_location', $1, 'rejected', 'GPS app')", [flag.id])).error).toBeNull();
    const [after] = await t.su<{ status: string }>("select status from mock_location_flags where id = $1", [flag.id]);
    expect(after.status).toBe("rejected");
  });

  it("refuses it when the Owner turns on the setting (and only the Owner can)", async () => {
    expect((await t.as(manager.authId, "select public.set_prosm_time_reject_mock_location(true)")).error).toMatch(/OWNER/);
    expect((await t.as(org.owner.authId, "select public.set_prosm_time_reject_mock_location(true)")).error).toBeNull();
    const emp = await employee("Mock Sara");
    expect((await clockInWith(emp, true)).error).toMatch(/A FAKE LOCATION IS NOT ACCEPTED/);
    expect((await clockInWith(emp, false)).error).toBeNull();
    expect((await t.as(org.owner.authId, "select public.set_prosm_time_reject_mock_location(false)")).error).toBeNull();
  });
});
