// 2026-11-01 (plan stage 4.7): behind require_gps the server refuses clock-in,
// clock-out and site change without a valid location, online or offline; an
// organisation with it off behaves as before. Migration 20261101150000.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockOut, createOrg, createSite, type TestMember } from "./support/fixtures";

const clockIn = (t: TestDatabase, member: TestMember, site: string, lat: number | null, lng: number | null, accuracy: number | null, offline = false) =>
  t.as(member.authId, "select public.clock_in_prosm_time_attendance($1, $2, null, $3, $4, $5, $6, null, null, null, $7)", [randomUUID(), site, offline ? new Date().toISOString() : null, lat, lng, accuracy, offline]);

async function setup(name: string) {
  const t = await buildDatabase();
  const org = await createOrg(t, name);
  const site = await createSite(t, org, "Main");
  const worker = await addMember(t, org, "employee", "Worker");
  await assignToSite(t, site, worker);
  return { t, org, site, worker };
}

describe("require_gps", () => {
  it("is on for a new organisation and refuses every bad reading", async () => {
    const { t, site, worker } = await setup("Gps Co");
    for (const [lat, lng, accuracy] of [[null, null, null], [0, 0, 10], [95, 31, 10], [30, 190, 10], [30, 31, null], [30, 31, -1], [30, 31, 9000]] as const) {
      expect((await clockIn(t, worker, site, lat, lng, accuracy)).error).toMatch(/LOCATION_REQUIRED/);
    }
    expect((await clockIn(t, worker, site, 30.02125, 31.75812, 8)).error).toBeNull();
  });

  it("an offline event with a valid reading goes through, and one without is refused", async () => {
    const { t, site, worker } = await setup("Offline Co");
    expect((await clockIn(t, worker, site, null, null, null, true)).error).toMatch(/LOCATION_REQUIRED/);
    expect((await clockIn(t, worker, site, 30.02125, 31.75812, 12, true)).error).toBeNull();
  });

  it("refuses clock-out and site change without a location", async () => {
    const { t, org, site, worker } = await setup("Out Co");
    const other = await createSite(t, org, "Other");
    expect((await clockIn(t, worker, site, 30.02125, 31.75812, 8)).error).toBeNull();
    expect((await t.as(worker.authId, "select public.clock_out_prosm_time_attendance($1, null, null, null, null)", [randomUUID()])).error).toMatch(/LOCATION_REQUIRED/);
    expect((await t.as(worker.authId, "select public.change_prosm_time_site(null, $1, null, null, null)", [other])).error).toMatch(/LOCATION_REQUIRED/);
    expect((await clockOut(t, worker)).error).toBeNull();
  });

  it("an organisation with it off keeps working without a location", async () => {
    const { t, org, site, worker } = await setup("Legacy Gps Co");
    await t.su("update organization_settings set require_gps = false where organization_id = $1", [org.id]);
    expect((await clockIn(t, worker, site, null, null, null)).error).toBeNull();
  });
});
