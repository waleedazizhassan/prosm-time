// v2.3.43 step 4 (item 6): allowances tied to time are paid for the minutes
// actually worked: 15 min at 100/h = 25, 7 min, 8 h 20 min; a basis per
// allowance type; an extra day only on a rest day or a holiday; pending hours
// count for nothing; approved entries never change. Migration 20261025130000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let site: string;
let worker: TestMember;

// A closed shift on a Cairo date; `to` may be on the next day ("+1 01:20").
async function shift(date: string, from: string, to: string, extra = "") {
  const [endDay, endTime] = to.startsWith("+1 ") ? [`(date '${date}' + 1)::text`, to.slice(3)] : [`'${date}'`, to];
  const [row] = await t.su<{ id: string }>(
    `insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at, clock_out_at ${extra ? ", hours_review_status" : ""})
     values ($1, $2, $3, 'clocked_out', ($4 || ' ' || $5)::timestamp at time zone 'Africa/Cairo', (${endDay} || ' ' || $6)::timestamp at time zone 'Africa/Cairo' ${extra ? ", '" + extra + "'" : ""})
     returning id`,
    [org.id, worker.userId, site, date, from, endTime],
  );
  return row.id;
}

async function save(date: string) {
  const result = await t.as(worker.authId, "select public.upsert_prosm_time_allowance_entry($1)", [date]);
  expect(result.error).toBeNull();
  const [row] = await t.su<{ overtime_minutes: string; overtime_amount: string; overtime_days: string; extra_days_amount: string; meal_allowance: string; transportation_allowance: string; day_type: string }>(
    "select overtime_minutes, overtime_amount, overtime_days, extra_days_amount, meal_allowance, transportation_allowance, day_type from allowance_entries where user_id = $1 and entry_date = $2",
    [worker.userId, date],
  );
  return row;
}

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Luxor");
  site = await createSite(t, org, "Temple Works");
  worker = await addMember(t, org, "employee", "Karim Hassan");
  await assignToSite(t, site, worker);
  // These tests are about the amounts: overtime counts without a manager's approval (step 6 default is "approval").
  await t.su("insert into overtime_policies (organization_id, approval_mode) values ($1, 'automatic')", [org.id]);
  await t.su("update sites set timezone = 'Africa/Cairo', overtime_start_time = '17:00' where id = $1", [site]);
  await t.as(org.owner.authId, "select public.set_prosm_time_allowance_rates($1, null, null, $2::jsonb)", [site, JSON.stringify({ overtimeHour: 100, meal: 50, transportation: 10 })]);
});

describe("allowances from the minutes worked (item 6)", () => {
  it("15 minutes of overtime at 100/hour is exactly 25", async () => {
    await shift("2026-10-25", "09:00", "17:15");
    const row = await save("2026-10-25");
    expect(Number(row.overtime_minutes)).toBeCloseTo(15, 6);
    expect(Number(row.overtime_amount)).toBe(25);
    expect(Number(row.meal_allowance)).toBe(50);
    expect(row.day_type).toBe("workday");
  });

  it("7 minutes is 11.67 (no rounding to a whole hour, no early rounding of the hours)", async () => {
    await shift("2026-10-26", "09:00", "17:07");
    const row = await save("2026-10-26");
    expect(Number(row.overtime_minutes)).toBeCloseTo(7, 6);
    expect(Number(row.overtime_amount)).toBe(11.67);
  });

  it("8 hours 20 minutes, past midnight, is 833.33", async () => {
    await shift("2026-10-27", "09:00", "+1 01:20");
    const row = await save("2026-10-27");
    expect(Number(row.overtime_minutes)).toBeCloseTo(500, 6);
    expect(Number(row.overtime_amount)).toBe(833.33);
  });

  it("an allowance set to per_hour is priced from the minutes worked", async () => {
    expect((await t.as(org.owner.authId, "select public.set_prosm_time_allowance_basis('transportation', 'per_hour')")).error).toBeNull();
    await shift("2026-10-28", "09:00", "13:30"); // 4.5 h, no overtime
    const row = await save("2026-10-28");
    expect(Number(row.transportation_allowance)).toBe(45);
    expect(Number(row.overtime_amount)).toBe(0);
    await t.as(org.owner.authId, "select public.set_prosm_time_allowance_basis('transportation', 'fixed_per_day')");
  });

  it("only the Owner sets the basis", async () => {
    const manager = await addMember(t, org, "manager", "Site Manager");
    expect((await t.as(manager.authId, "select public.set_prosm_time_allowance_basis('meal', 'per_hour')")).error).toMatch(/ONLY THE OWNER/);
  });

  it("a Friday worked is an extra day when there is an extra-day price, otherwise all overtime", async () => {
    await shift("2026-10-30", "10:00", "14:00"); // Friday
    let row = await save("2026-10-30");
    expect(row.day_type).toBe("weekly_rest");
    expect(Number(row.overtime_minutes)).toBeCloseTo(240, 6);
    expect(Number(row.overtime_amount)).toBe(400);
    expect(Number(row.overtime_days)).toBe(0);
    await t.as(org.owner.authId, "select public.set_prosm_time_allowance_rates($1, null, null, $2::jsonb)", [site, JSON.stringify({ overtimeHour: 100, meal: 50, transportation: 10, extraDay: 300 })]);
    row = await save("2026-10-30");
    expect(Number(row.overtime_days)).toBe(1);
    expect(Number(row.extra_days_amount)).toBe(300);
    expect(Number(row.overtime_amount)).toBe(0);
  });

  it("a normal day with overtime is no longer an extra day", async () => {
    const row = await save("2026-10-25");
    expect(Number(row.overtime_days)).toBe(0);
    expect(Number(row.extra_days_amount)).toBe(0);
  });

  it("pending hours count for nothing", async () => {
    await shift("2026-11-01", "09:00", "19:00", "pending");
    const row = await save("2026-11-01");
    expect(Number(row.overtime_minutes)).toBe(0);
    expect(Number(row.overtime_amount)).toBe(0);
  });

  it("an approved entry is never recalculated", async () => {
    await t.su("update allowance_entries set status = 'approved', overtime_amount = 999 where user_id = $1 and entry_date = '2026-10-26'", [worker.userId]);
    const [{ id }] = await t.su<{ id: string }>("select id from allowance_entries where user_id = $1 and entry_date = '2026-10-26'", [worker.userId]);
    await t.su("select public.prosm_time_refresh_allowance_entry($1)", [id]);
    const [{ amount }] = await t.su<{ amount: string }>("select overtime_amount as amount from allowance_entries where id = $1", [id]);
    expect(Number(amount)).toBe(999);
    expect((await t.as(worker.authId, "select public.upsert_prosm_time_allowance_entry('2026-10-26')")).error).toMatch(/ALREADY APPROVED/);
  });
});
