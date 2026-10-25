// v2.3.43 steps 14-15 (items 17, 18): the people directory - photo, role
// order, sites, live status - for the people the caller sees, and nobody
// from another organisation. Migration 20261025230000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let other: TestOrg;
let worker: TestMember;
let manager: TestMember;
let stranger: TestMember;

type Row = { id: string; avatar_url: string | null; role_key: string; role_sort: number; site_names: string[]; presence: string };

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Tanta");
  other = await createOrg(t, "Zagazig");
  const site = await createSite(t, org, "Mill");
  worker = await addMember(t, org, "employee", "Rana Adel");
  manager = await addMember(t, org, "manager", "Mill Manager");
  stranger = await addMember(t, other, "employee", "Other Org");
  await assignToSite(t, site, worker);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, manager.userId]);
  await t.su("update users set avatar_url = 'https://example.test/users/x/a.png' where id = $1", [worker.userId]);
  expect((await clockIn(t, worker, site)).error).toBeNull();
});

describe("people directory", () => {
  it("gives photo, role order, sites and live status", async () => {
    const result = await t.as<Row>(manager.authId, "select * from public.list_prosm_time_people_directory()");
    expect(result.error).toBeNull();
    const row = result.rows!.find((r) => r.id === worker.userId)!;
    expect(row.avatar_url).toContain("a.png");
    expect(row.role_key).toBe("employee");
    expect(row.role_sort).toBe(40);
    expect(row.site_names).toEqual(["Mill"]);
    expect(row.presence).toBe("in");
  });

  it("never includes people of another organisation", async () => {
    const result = await t.as<Row>(org.owner.authId, "select * from public.list_prosm_time_people_directory()");
    expect(result.rows!.map((r) => r.id)).not.toContain(stranger.userId);
    expect(result.rows!.map((r) => r.id)).toContain(worker.userId);
  });

  it("roles have their group order", async () => {
    const rows = await t.su<{ role_key: string; sort_order: number }>("select role_key, sort_order from roles order by sort_order");
    expect(rows.map((r) => r.role_key)).toEqual(["owner", "manager", "supervisor", "employee", "read_only"]);
  });
});
