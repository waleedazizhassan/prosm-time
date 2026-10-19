// Owner 2026-10-18/19: external workers are added for the organisation,
// the app generates their 6-digit number, and they clock in with it at
// any site's kiosk. Migration 20261019100000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let other: TestOrg;
let tower: string;
let factory: string;
let otherSite: string;
let employee: TestMember;

const create = (member: TestMember, name: string, contractor: string | null = null) =>
  t.as<{ r: { workerNumber: string; workerId: string } }>(member.authId, "select public.create_prosm_time_external_worker($1, $2) as r", [name, contractor]);
const kiosk = (member: TestMember, action: "in" | "out", siteId: string, number: string) =>
  t.as(member.authId, `select public.kiosk_worker_clock_${action}($1, $2, 30.02, 31.75) as r`, [siteId, number]);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  other = await createOrg(t, "Orbit");
  tower = await createSite(t, org, "Tower B");
  factory = await createSite(t, org, "Factory");
  otherSite = await createSite(t, other, "Orbit Yard");
  employee = await addMember(t, org, "employee", "Omar Hassan");
});

describe("external workforce", () => {
  it("generates a unique 6-digit number for each worker, with no site", async () => {
    const numbers = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      const result = await create(org.owner, `Worker ${i}`, "Delta Contracting");
      expect(result.error).toBeNull();
      const number = result.rows?.[0].r.workerNumber ?? "";
      expect(number).toMatch(/^[1-9][0-9]{5}$/);
      numbers.add(number);
    }
    expect(numbers.size).toBe(25);
    const [row] = await t.su<{ n: number }>("select count(*)::int as n from site_workers where organization_id = $1 and site_id is null", [org.id]);
    expect(row.n).toBe(25);
  });

  it("lists the organisation's workers and refuses a plain employee", async () => {
    const list = await t.as<{ full_name: string }>(org.owner.authId, "select * from public.list_prosm_time_external_workers()");
    expect(list.rows).toHaveLength(25);
    expect((await t.as(employee.authId, "select * from public.list_prosm_time_external_workers()")).error).toMatch(/NOT AUTHORIZED/);
    expect((await create(employee, "Sneaky")).error).toMatch(/NOT AUTHORIZED/);
  });

  it("clocks a worker in at one site's kiosk and out at another's", async () => {
    const number = (await create(org.owner, "Hany Said")).rows?.[0].r.workerNumber ?? "";
    expect((await kiosk(org.owner, "in", tower, number)).error).toBeNull();
    const list = await t.as<{ full_name: string; current_site_name: string | null }>(org.owner.authId, "select full_name, current_site_name from public.list_prosm_time_external_workers() where full_name = 'Hany Said'");
    expect(list.rows?.[0].current_site_name).toBe("Tower B");
    expect((await kiosk(org.owner, "out", factory, number)).error).toBeNull();
  });

  it("refuses another organisation's site, an unknown number and an inactive worker", async () => {
    const created = (await create(org.owner, "Sami Adel")).rows?.[0].r;
    expect((await kiosk(org.owner, "in", otherSite, created?.workerNumber ?? "")).error).toMatch(/SITE NOT FOUND/);
    expect((await kiosk(org.owner, "in", tower, "000000")).error).toMatch(/NO WORKER WITH THIS NUMBER/);
    expect((await t.as(org.owner.authId, "select public.update_prosm_time_external_worker($1, 'Sami Adel', null, 'inactive')", [created?.workerId])).error).toBeNull();
    expect((await kiosk(org.owner, "in", tower, created?.workerNumber ?? "")).error).toMatch(/NOT ACTIVE/);
  });
});
