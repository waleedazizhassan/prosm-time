// 2026-11-01 (plan stage 4.7): behind require_gps the server refuses clock-in,
// clock-out and site change without a valid location, online or offline; an
// organisation with it off behaves as before. Migration 20261101150000.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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

  it("a break needs a location to start and end, and keeps it", async () => {
    const { t, site, worker } = await setup("Break Co");
    expect((await clockIn(t, worker, site, 30.02125, 31.75812, 8)).error).toBeNull();
    const [session] = await t.su<{ id: string }>("select id from attendance_sessions where user_id = $1", [worker.userId]);
    const start = "select public.start_prosm_time_break($1, $2, null, false, $3, $4, $5) as r";
    expect((await t.as(worker.authId, start, [session.id, randomUUID(), null, null, null])).error).toMatch(/LOCATION_REQUIRED/);
    const started = await t.as<{ r: { breakId: string } }>(worker.authId, start, [session.id, randomUUID(), 30.02125, 31.75812, 8]);
    expect(started.error).toBeNull();
    const breakId = started.rows![0].r.breakId;
    const end = "select public.end_prosm_time_break($1, $2, null, false, $3, $4, $5)";
    expect((await t.as(worker.authId, end, [breakId, randomUUID(), null, null, null])).error).toMatch(/LOCATION_REQUIRED/);
    expect((await t.as(worker.authId, end, [breakId, randomUUID(), 30.02126, 31.75813, 9])).error).toBeNull();
    const [row] = await t.su<{ start_latitude: number; end_latitude: number }>("select start_latitude, end_latitude from break_events where id = $1", [breakId]);
    expect(row).toMatchObject({ start_latitude: 30.02125, end_latitude: 30.02126 });
  });

  it("refuses recording on someone's behalf without a location from the device recording it", async () => {
    const { t, org, site, worker } = await setup("Behalf Co");
    const manager = await addMember(t, org, "manager", "Manager");
    await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, manager.userId]);
    const result = await t.as(manager.authId, "select public.admin_clock_in_prosm_time_attendance($1, $2, 'Phone broken', null, $3)", [worker.userId, site, randomUUID()]);
    expect(result.error).toMatch(/LOCATION_REQUIRED/);
  });

  it("an organisation with it off keeps working without a location", async () => {
    const { t, org, site, worker } = await setup("Legacy Gps Co");
    await t.su("update organization_settings set require_gps = false where organization_id = $1", [org.id]);
    expect((await clockIn(t, worker, site, null, null, null)).error).toBeNull();
  });

  // 2026-11-10 (owner): an older organisation with it off let a clock-in with no location skip the
  // area and fake-location checks; migration 20261110160000 turns it on everywhere.
  it("is turned on for older organisations that had it off, with an audit row", async () => {
    const { t, org, site, worker } = await setup("Old Co");
    await t.su("update organization_settings set require_gps = false where organization_id = $1", [org.id]);
    const sql = readFileSync(new URL("../migrations/20261110160000_require_location_everywhere.sql", import.meta.url), "utf8");
    // the migration's one statement (without begin/commit)
    await t.su(sql.slice(sql.indexOf("with changed"), sql.lastIndexOf(";", sql.indexOf("commit;") - 1)));
    expect((await clockIn(t, worker, site, null, null, null)).error).toMatch(/LOCATION_REQUIRED/);
    const audit = await t.su("select 1 from audit_logs where organization_id = $1 and action = 'require_gps_turned_on'", [org.id]);
    expect(audit.length).toBe(1);
  });
});
