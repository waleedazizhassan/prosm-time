// Owner 2026-10-20: allowances priced per site, category and person (the
// later wins), a new day filled from the prices of the site worked, overtime
// priced. Migration 20261020260000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, clockOut, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let siteA: string;
let siteB: string;
let managerA: TestMember;
let engineer: TestMember;
let worker: TestMember;
let categoryId: string;

const setRates = (caller: TestMember, scope: { site?: string | null; category?: string | null; user?: string | null }, rates: Record<string, number | null>) =>
  t.as(caller.authId, "select public.set_prosm_time_allowance_rates($1, $2, $3, $4::jsonb)", [scope.site ?? null, scope.category ?? null, scope.user ?? null, JSON.stringify(rates)]);
const resolved = async (member: TestMember, siteId: string) =>
  (await t.su<{ r: Record<string, number | null> }>("select public.prosm_time_resolve_allowance_rates($1, $2) as r", [member.userId, siteId]))[0].r;

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  siteA = await createSite(t, org, "Capital");
  siteB = await createSite(t, org, "Factory", { latitude: 30.3, longitude: 31.9 });
  managerA = await addMember(t, org, "manager", "Mona");
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [siteA, managerA.userId]);
  engineer = await addMember(t, org, "employee", "Hana");
  worker = await addMember(t, org, "employee", "Omar");
  for (const member of [engineer, worker]) await assignToSite(t, siteA, member);
});

describe("allowance prices", () => {
  it("applies site, then category, then the person's own price", async () => {
    expect((await setRates(org.owner, { site: siteA }, { meal: 50, expatriation: 100, transportation: 30, overtimeHour: 20, extraDay: 150 })).error).toBeNull();
    const created = await t.as<{ r: { categoryId: string } }>(org.owner.authId, "select public.save_prosm_time_allowance_category(null, 'Engineers') as r");
    categoryId = created.rows![0].r.categoryId;
    expect((await t.as(org.owner.authId, "select public.set_prosm_time_allowance_category_member($1, $2)", [engineer.userId, categoryId])).error).toBeNull();
    expect((await setRates(org.owner, { category: categoryId }, { expatriation: 200 })).error).toBeNull();
    expect((await setRates(org.owner, { category: categoryId, site: siteA }, { expatriation: 250 })).error).toBeNull();
    expect((await setRates(org.owner, { user: engineer.userId }, { meal: 80 })).error).toBeNull();

    expect(await resolved(worker, siteA)).toMatchObject({ meal: 50, expatriation: 100, transportation: 30 });
    expect(await resolved(engineer, siteA)).toMatchObject({ meal: 80, expatriation: 250, transportation: 30, overtimeHour: 20 });
    // At a site with no price of its own, the category's every-site price still applies.
    expect(await resolved(engineer, siteB)).toMatchObject({ meal: 80, expatriation: 200, transportation: null });
  });

  it("lets a manager price only the sites they manage, and never every site", async () => {
    // Saving a scope sets all its prices at once (the form sends them all).
    expect((await setRates(managerA, { site: siteA }, { meal: 50, expatriation: 100, transportation: 30, housing: 40, overtimeHour: 20, extraDay: 150 })).error).toBeNull();
    expect((await setRates(managerA, { site: siteB }, { housing: 40 })).error).toMatch(/ONLY THE OWNER/);
    expect((await setRates(managerA, { category: categoryId }, { housing: 40 })).error).toMatch(/ONLY THE OWNER/);
    expect((await setRates(managerA, { user: worker.userId, site: siteA }, { travel: 10 })).error).toBeNull();
    expect((await setRates(engineer, { site: siteA }, { meal: 1 })).error).toMatch(/AUTHORITY REQUIRED/);
  });

  it("fills a worked day from the prices, keeping what has no price for the employee", async () => {
    expect((await clockIn(t, engineer, siteA)).error).toBeNull();
    expect((await clockOut(t, engineer)).error).toBeNull();
    const filled = await t.as<{ r: { filled: number } }>(engineer.authId, "select public.fill_prosm_time_allowances(current_date - 1, current_date + 1) as r");
    expect(filled.error).toBeNull();
    expect(filled.rows![0].r.filled).toBe(1);
    const [entry] = await t.su<Record<string, string>>(
      "select meal_allowance, expatriation_allowance, transportation_allowance, housing_allowance, travel_allowance from allowance_entries where user_id = $1",
      [engineer.userId],
    );
    expect(entry).toEqual({ meal_allowance: "80.00", expatriation_allowance: "250.00", transportation_allowance: "30.00", housing_allowance: "40.00", travel_allowance: "0.00" });

    // Filling again leaves the started day alone; the employee's own edit stands.
    const again = await t.as<{ r: { filled: number } }>(engineer.authId, "select public.fill_prosm_time_allowances(current_date - 1, current_date + 1) as r");
    expect(again.rows![0].r.filled).toBe(0);
    expect((await t.as(engineer.authId, "select public.upsert_prosm_time_allowance_entry(current_date, 0, 250, 30, 40, 120, 0, null)")).error).toBeNull();
    const [edited] = await t.su<{ meal_allowance: string; travel_allowance: string }>("select meal_allowance, travel_allowance from allowance_entries where user_id = $1", [engineer.userId]);
    expect(edited).toEqual({ meal_allowance: "0.00", travel_allowance: "120.00" });
  });

  it("hides prices from employees, who see only their own", async () => {
    const rows = await t.as<{ n: number }>(worker.authId, "select count(*)::int as n from allowance_rates");
    expect(rows.error).toBeNull();
    expect(rows.rows![0].n).toBe(0);
    const mine = await t.as<{ r: { siteName: string; rates: Record<string, number | null> }[] }>(worker.authId, "select public.get_prosm_time_my_allowance_rates() as r");
    expect(mine.error).toBeNull();
    expect(mine.rows![0].r[0]).toMatchObject({ siteName: "Capital", rates: { meal: 50, travel: 10 } });
  });
});
