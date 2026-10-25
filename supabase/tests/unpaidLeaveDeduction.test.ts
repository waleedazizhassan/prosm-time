// v2.3.43 step 9 (item 19): unpaid leave approved with its deduction per day:
// two days x 300 = 600; a weekly rest day inside the leave is not deducted;
// cancelling before it starts reverses it; the suggestion from the pay rate.
// Migration 20261025180000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let worker: TestMember;
let manager: TestMember;
let supervisor: TestMember;

const cairoDay = async (days: number) =>
  (await t.su<{ d: string }>("select ((now() at time zone 'Africa/Cairo')::date + $1::int)::text as d", [days]))[0].d;

// A pending unpaid leave over the next workdays (skipping Friday to start).
async function pendingUnpaid(start: string, end: string) {
  const [row] = await t.su<{ id: string }>(
    "insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count) values ($1, $2, 'unpaid', $3, $4, ($4::date - $3::date) + 1) returning id",
    [org.id, worker.userId, start, end],
  );
  return row.id;
}
const active = async (id: string) =>
  t.su<{ amount: string; work_date: string }>("select amount, work_date::text from payroll_adjustments where source_id = $1 and status = 'active' order by work_date", [id]);

// The next Monday on or after `from` days from today.
async function nextWeekday(dow: number, from = 2) {
  const [{ d }] = await t.su<{ d: string }>(
    "select (d)::date::text as d from generate_series((now() at time zone 'Africa/Cairo')::date + $2::int, (now() at time zone 'Africa/Cairo')::date + $2::int + 7, interval '1 day') d where extract(dow from d) = $1 limit 1",
    [dow, from],
  );
  return d;
}

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Sohag");
  const site = await createSite(t, org, "Workshop");
  worker = await addMember(t, org, "employee", "Mostafa Ali");
  manager = await addMember(t, org, "manager", "Workshop Manager");
  supervisor = await addMember(t, org, "supervisor", "Workshop Supervisor");
  for (const member of [worker, supervisor]) await assignToSite(t, site, member);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, manager.userId]);
  await t.su("insert into worker_pay_rates (organization_id, user_id, rate_type, rate_amount, currency) values ($1, $2, 'MONTHLY', 9000, 'EGP')", [org.id, worker.userId]);
});

describe("unpaid leave deduction (item 19)", () => {
  it("suggests the monthly rate / 30 = 300 a day", async () => {
    const monday = await nextWeekday(1);
    const id = await pendingUnpaid(monday, monday);
    const result = await t.as<{ s: { perDay: number } }>(manager.authId, "select public.suggest_prosm_time_leave_deduction($1) as s", [id]);
    expect(result.rows?.[0].s.perDay).toBe(300);
    await t.su("delete from leave_requests where id = $1", [id]);
  });

  it("approving unpaid leave needs the deduction; two days x 300 = 600, one row per day", async () => {
    const monday = await nextWeekday(1);
    const tuesday = (await t.su<{ d: string }>("select ($1::date + 1)::text as d", [monday]))[0].d;
    const id = await pendingUnpaid(monday, tuesday);
    expect((await t.as(manager.authId, "select public.review_prosm_time_leave($1, 'approved', null, null)", [id])).error).toMatch(/DEDUCTION PER DAY IS REQUIRED/);
    expect((await t.as(manager.authId, "select public.review_prosm_time_leave($1, 'approved', 'ok', 300)", [id])).error).toBeNull();
    const [row] = await t.su<{ deduction_total: string; deduction_days: string }>("select deduction_total, deduction_days from leave_requests where id = $1", [id]);
    expect(Number(row.deduction_total)).toBe(600);
    expect(Number(row.deduction_days)).toBe(2);
    expect((await active(id)).map((r) => Number(r.amount))).toEqual([-300, -300]);
  });

  it("a weekly rest day inside the leave is not deducted", async () => {
    const thursday = await nextWeekday(4, 9);
    const saturday = (await t.su<{ d: string }>("select ($1::date + 2)::text as d", [thursday]))[0].d;
    const id = await pendingUnpaid(thursday, saturday); // Thu, Fri (rest), Sat
    expect((await t.as(manager.authId, "select public.review_prosm_time_leave($1, 'approved', null, 300)", [id])).error).toBeNull();
    const rows = await active(id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.work_date)).not.toContain((await t.su<{ d: string }>("select ($1::date + 1)::text as d", [thursday]))[0].d);
    const [{ total }] = await t.su<{ total: string }>("select deduction_total as total from leave_requests where id = $1", [id]);
    expect(Number(total)).toBe(600);
  });

  it("cancelling before it starts reverses the deduction", async () => {
    const day = await nextWeekday(1, 16);
    const id = await pendingUnpaid(day, day);
    await t.as(manager.authId, "select public.review_prosm_time_leave($1, 'approved', null, 250)", [id]);
    expect(await active(id)).toHaveLength(1);
    expect((await t.as(worker.authId, "select public.cancel_prosm_time_leave_request($1)", [id])).error).toBeNull();
    expect(await active(id)).toHaveLength(0);
  });

  it("someone without leave.set_deduction cannot approve unpaid leave; only the Owner changes the amount later", async () => {
    const day = await nextWeekday(2, 23);
    const id = await pendingUnpaid(day, day);
    await t.su(
      "insert into user_permission_overrides (user_id, permission_id, is_granted, granted_by, reason) select $1, id, false, $2, 'test' from permissions where permission_key = 'leave.set_deduction'",
      [manager.userId, org.owner.userId],
    );
    expect((await t.as(manager.authId, "select public.review_prosm_time_leave($1, 'approved', null, 300)", [id])).error).toMatch(/SET_DEDUCTION/);
    expect((await t.as(org.owner.authId, "select public.review_prosm_time_leave($1, 'approved', null, 300)", [id])).error).toBeNull();
    expect((await t.as(manager.authId, "select public.adjust_prosm_time_leave_deduction($1, 200, 'x')", [id])).error).toMatch(/ONLY THE OWNER/);
    expect((await t.as(org.owner.authId, "select public.adjust_prosm_time_leave_deduction($1, 200, 'agreed with the employee')", [id])).error).toBeNull();
    expect((await active(id)).map((r) => Number(r.amount))).toEqual([-200]);
    expect(await t.su("select id from audit_logs where action = 'leave.deduction_changed'")).toHaveLength(1);
  });

  it("the employee sees their deductions", async () => {
    const from = await cairoDay(0);
    const to = await cairoDay(60);
    const result = await t.as<{ amount: string }>(worker.authId, "select * from public.list_prosm_time_payroll_adjustments(null, $1, $2)", [from, to]);
    expect(result.error).toBeNull();
    expect(result.rows!.length).toBeGreaterThan(0);
  });
});
