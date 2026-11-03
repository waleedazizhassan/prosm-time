// Owner 2026-11-03: "the site box in the allowance sheet doesn't fill" - and allowances
// smarter (his PROSM Allow app). Migration 20261104100000: a day follows its attendance on
// every change, a day without attendance can have its own site and its prices, and the open
// days can be priced again from the current prices.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let capital: string;
let plant: string;
let hana: TestMember;

const setRates = (scope: { site?: string | null }, rates: Record<string, number | null>) =>
  t.as(org.owner.authId, "select public.set_prosm_time_allowance_rates($1, null, null, $2::jsonb)", [scope.site ?? null, JSON.stringify(rates)]);
const save = (day: string, values: number[], site?: string | null) =>
  site === undefined
    ? t.as(hana.authId, "select public.upsert_prosm_time_allowance_entry($1::date, $2, $3, $4, $5, $6, $7, null)", [day, ...values])
    : t.as(hana.authId, "select public.upsert_prosm_time_allowance_entry($1::date, $2, $3, $4, $5, $6, $7, null, $8, true)", [day, ...values, site]);
const entry = async (day: string) =>
  (
    await t.su<{ site_id: string | null; attendance_session_id: string | null; expatriation_allowance: string; transportation_allowance: string; travel_allowance: string }>(
      "select site_id, attendance_session_id, expatriation_allowance, transportation_allowance, travel_allowance from allowance_entries where user_id = $1 and entry_date = $2::date",
      [hana.userId, day],
    )
  )[0];

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Delta");
  capital = await createSite(t, org, "Capital");
  plant = await createSite(t, org, "Plant", { latitude: 30.3, longitude: 31.9 });
  hana = await addMember(t, org, "employee", "Hana");
  await assignToSite(t, capital, hana);
  await assignToSite(t, plant, hana);
  expect((await setRates({ site: capital }, { expatriation: 200, transportation: 50 })).error).toBeNull();
  expect((await setRates({ site: plant }, { expatriation: 150, transportation: 80 })).error).toBeNull();
});

describe("the site of an allowance day", () => {
  it("prices a day without attendance at the site chosen for it", async () => {
    expect((await save("2026-09-01", [0, 0, 0, 0, 0, 0], capital)).error).toBeNull();
    expect(await entry("2026-09-01")).toMatchObject({ site_id: capital, expatriation_allowance: "200.00", transportation_allowance: "50.00" });
  });

  it("moves a day to another site with that site's prices, keeping what has no price", async () => {
    expect((await save("2026-09-01", [0, 200, 50, 0, 120, 0], plant)).error).toBeNull();
    expect(await entry("2026-09-01")).toMatchObject({ site_id: plant, expatriation_allowance: "150.00", transportation_allowance: "80.00", travel_allowance: "120.00" });
  });

  it("leaves the site alone when the save does not touch it", async () => {
    expect((await save("2026-09-01", [0, 150, 90, 0, 120, 0])).error).toBeNull();
    expect(await entry("2026-09-01")).toMatchObject({ site_id: plant, transportation_allowance: "90.00" });
  });

  it("refuses a site of another organisation", async () => {
    const other = await createOrg(t, "Other");
    const foreign = await createSite(t, other, "Elsewhere");
    expect((await save("2026-09-02", [0, 0, 0, 0, 0, 0], foreign)).error).toMatch(/SITE NOT FOUND/);
  });

  it("links a day to a shift recorded already closed (on someone's behalf, a correction)", async () => {
    expect((await save("2026-09-03", [0, 0, 0, 0, 0, 0])).error).toBeNull();
    expect((await entry("2026-09-03")).attendance_session_id).toBeNull();
    const [session] = await t.su<{ id: string }>(
      `insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at, clock_out_at)
       values ($1, $2, $3, 'clocked_out', '2026-09-03 06:00+00', '2026-09-03 14:00+00') returning id`,
      [org.id, hana.userId, capital],
    );
    expect((await entry("2026-09-03")).attendance_session_id).toBe(session.id);
  });

  it("follows a shift whose times change", async () => {
    const [session] = await t.su<{ id: string }>(
      `insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at, clock_out_at)
       values ($1, $2, $3, 'clocked_out', '2026-09-04 06:00+00', '2026-09-04 10:00+00') returning id`,
      [org.id, hana.userId, capital],
    );
    expect((await save("2026-09-04", [0, 0, 0, 0, 0, 0])).error).toBeNull();
    const before = (await t.su<{ worked_minutes: string }>("select worked_minutes from allowance_entries where attendance_session_id = $1", [session.id]))[0];
    await t.su("update attendance_sessions set clock_out_at = '2026-09-04 14:00+00' where id = $1", [session.id]);
    const after = (await t.su<{ worked_minutes: string }>("select worked_minutes from allowance_entries where attendance_session_id = $1", [session.id]))[0];
    expect(Number(after.worked_minutes)).toBeGreaterThan(Number(before.worked_minutes));
  });
});

describe("apply the current prices", () => {
  it("prices the open days again, keeping what has no price", async () => {
    expect((await setRates({ site: plant }, { expatriation: 175, transportation: 80 })).error).toBeNull();
    const result = await t.as<{ r: { priced: number } }>(hana.authId, "select public.reprice_prosm_time_allowances('2026-09-01', '2026-09-30') as r");
    expect(result.error).toBeNull();
    expect(result.rows![0].r.priced).toBeGreaterThan(0);
    expect(await entry("2026-09-01")).toMatchObject({ expatriation_allowance: "175.00", transportation_allowance: "80.00", travel_allowance: "120.00" });
  });

  it("never changes an approved day", async () => {
    await t.su("update allowance_entries set status = 'approved' where user_id = $1 and entry_date = '2026-09-01'", [hana.userId]);
    expect((await setRates({ site: plant }, { expatriation: 300 })).error).toBeNull();
    expect((await t.as(hana.authId, "select public.reprice_prosm_time_allowances('2026-09-01', '2026-09-30')")).error).toBeNull();
    expect((await entry("2026-09-01")).expatriation_allowance).toBe("175.00");
  });
});
