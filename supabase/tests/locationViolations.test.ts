// Audit 2026-10-12, item 2.2 (T58) - a clock-in 30 km outside the work
// area must appear in the Location Violations report. Migration 20261013130000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let factory: string;
let otherSite: string;
let mona: TestMember;
let factoryManager: TestMember;
let otherManager: TestMember;

interface ViolationRow {
  violation_type: string;
  user_full_name: string;
  site_name: string;
  distance_meters: number;
  employee_reason: string | null;
  review_status: string | null;
}

const today = () => new Date().toISOString().slice(0, 10);
const report = async (member: TestMember) => {
  const result = await t.as<ViolationRow>(member.authId, "select * from public.list_prosm_time_report_location_violations($1, $1)", [today()]);
  if (result.error) throw new Error(result.error);
  return result.rows ?? [];
};

async function manager(name: string, siteId: string): Promise<TestMember> {
  const member = await addMember(t, org, "manager", name);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [siteId, member.userId]);
  return member;
}

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  factory = await createSite(t, org, "Factory 10th of Ramadan", { latitude: 30.2961, longitude: 31.7458, radius: 150 });
  otherSite = await createSite(t, org, "Tower B");
  await t.su("update sites set geofence_required = true where id = $1", [factory]);
  mona = await addMember(t, org, "employee", "Mona Elsayed");
  await assignToSite(t, factory, mona);
  factoryManager = await manager("Factory Manager", factory);
  otherManager = await manager("Tower Manager", otherSite);

  // ~30 km from the factory (T57).
  const result = await clockIn(t, mona, factory, { latitude: 30.0212, longitude: 31.7581 });
  if (result.error) throw new Error(result.error);
});

describe("Location Violations report (audit 2.2)", () => {
  it("lists a clock-in outside the work area for the owner, with site, distance and status", async () => {
    const rows = await report(org.owner);
    const outside = rows.filter((row) => row.violation_type === "outside_work_area");
    expect(outside).toHaveLength(1);
    expect(outside[0]).toMatchObject({ user_full_name: "Mona Elsayed", site_name: "Factory 10th of Ramadan", review_status: "pending_reason" });
    expect(outside[0].distance_meters).toBeGreaterThan(25_000);
  });

  it("shows the employee's reason once given", async () => {
    await t.su("update geofence_exceptions set employee_reason = 'Buying supplies', status = 'pending_review' where user_id = $1", [mona.userId]);
    const [row] = (await report(org.owner)).filter((r) => r.violation_type === "outside_work_area");
    expect(row).toMatchObject({ employee_reason: "Buying supplies", review_status: "pending_review" });
  });

  it("keeps the implausible-location rows", async () => {
    await t.su(
      "insert into location_plausibility_flags (organization_id, user_id, site_id, previous_latitude, previous_longitude, previous_at, latitude, longitude, occurred_at, distance_meters, implied_speed_kmh) values ($1, $2, $3, 30.02, 31.75, now() - interval '3 minutes', 30.3, 31.74, now(), 50000, 900)",
      [org.id, mona.userId, factory],
    );
    const types = (await report(org.owner)).map((row) => row.violation_type).sort();
    expect(types).toEqual(["implausible_location", "outside_work_area"]);
  });

  it("scopes a manager to the sites they manage", async () => {
    expect(await report(factoryManager)).toHaveLength(2);
    expect(await report(otherManager)).toHaveLength(0);
  });
});
