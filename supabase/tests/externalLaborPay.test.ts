// 2026-11-08 B-07 external labour pay (migration 20261108170000): rates by day/week/month/year,
// pay runs with the work quantity from the kiosk or entered by hand, the organisation's policy,
// individual adjustments with a reason (days through the day-rate rule), approval with a frozen
// snapshot, reopen with a reason, totals per currency, scope, and isolation from payroll.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let other: TestOrg;
let siteA: string;
let siteB: string;
let managerA: TestMember;
let accountant: TestMember;
let daily = "";
let monthly = "";
let yearly = "";
let weekly = "";
let usd = "";
let atSiteB = "";
let runId = "";

async function ok<T>(result: Promise<{ rows: T[] | null; error: string | null }>): Promise<T> {
  const { rows, error } = await result;
  if (error) throw new Error(error);
  return rows![0];
}
const owner = (sql: string, params: unknown[] = []) => t.as(org.owner.authId, sql, params);
type Worker = { runWorkerId: string; workerId: string; name: string; unit: string; quantity: number | null; gross: number | null; net: number | null;
  additions: number; deductions: number; attendanceDays: number; policyLines: { name: string; amount: number }[]; adjustments: { amount: number; reason: string }[] };
type Run = { r: { run: { status: string; isDraft: boolean; rowVersion: number; runVersion: number }; workers: Worker[]; totals: { currency: string; net: number; workers: number }[] } };
const run = async (as = org.owner.authId) => (await ok<Run>(t.as(as, "select public.get_prosm_time_external_run($1) as r", [runId]))).r;
const worker = async (id: string) => (await run()).workers.find((row) => row.workerId === id)!;

async function newWorker(name: string, site: string | null): Promise<string> {
  const created = await ok<{ r: { workerId?: string; id?: string } }>(owner("select public.create_prosm_time_external_worker($1, 'Contractor X') as r", [name]));
  const id = (created.r.workerId ?? created.r.id)!;
  if (site) await t.su("update site_workers set site_id = $2 where id = $1", [id, site]);
  return id;
}

beforeAll(async () => {
  t = await buildDatabase();
  expect(t.failures).toEqual([]);
  org = await createOrg(t, "Crew Co");
  other = await createOrg(t, "Other Crew");
  siteA = await createSite(t, org, "Yard A");
  siteB = await createSite(t, org, "Yard B");
  managerA = await addMember(t, org, "manager", "Manager A");
  accountant = await addMember(t, org, "employee", "Accountant");
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [siteA, managerA.userId]);
  for (const key of ["external_labor.view", "external_labor.manage", "external_labor.adjust"]) {
    await ok(owner("select public.set_prosm_time_user_permission_override($1, $2, true, 'site A external pay')", [managerA.userId, key]));
  }
  await ok(owner("select public.set_prosm_time_user_permission_override($1, 'payroll.view', true, 'payroll only')", [accountant.userId]));
  daily = await newWorker("Daily Dan", siteA);
  monthly = await newWorker("Monthly Mona", siteA);
  yearly = await newWorker("Yearly Yara", siteA);
  weekly = await newWorker("Weekly Wael", siteA);
  usd = await newWorker("Dollar Dina", siteA);
  atSiteB = await newWorker("Site B Basem", siteB);
  // three kiosk days for the daily worker in May 2027
  for (const day of ["2027-05-03", "2027-05-04", "2027-05-05"]) {
    await t.su(
      "insert into site_worker_attendance (organization_id, site_worker_id, site_id, clock_in_at, clock_out_at, clock_in_latitude, clock_in_longitude) values ($1, $2, $3, ($4::date + time '08:00') at time zone 'Africa/Cairo', ($4::date + time '16:00') at time zone 'Africa/Cairo', 30, 31)",
      [org.id, daily, siteA, day],
    );
  }
});

describe("rates", () => {
  it("take an amount, a currency and one of the units; bad values are refused", async () => {
    await ok(owner("select public.set_prosm_time_external_rate($1, 500, 'egp', 'DAILY', '2027-01-01')", [daily]));
    await ok(owner("select public.set_prosm_time_external_rate($1, 9000, 'EGP', 'MONTHLY', '2027-01-01')", [monthly]));
    await ok(owner("select public.set_prosm_time_external_rate($1, 120000, 'EGP', 'YEARLY', '2027-01-01')", [yearly]));
    await ok(owner("select public.set_prosm_time_external_rate($1, 2500, 'EGP', 'WEEKLY', '2027-01-01')", [weekly]));
    await ok(owner("select public.set_prosm_time_external_rate($1, 40, 'USD', 'DAILY', '2027-01-01')", [usd]));
    await ok(owner("select public.set_prosm_time_external_rate($1, 450, 'EGP', 'DAILY', '2027-01-01')", [atSiteB]));
    expect((await owner("select public.set_prosm_time_external_rate($1, 0, 'EGP', 'DAILY')", [daily])).error).toMatch(/GREATER THAN ZERO/);
    expect((await owner("select public.set_prosm_time_external_rate($1, 10, 'EGYPT', 'DAILY')", [daily])).error).toMatch(/INVALID CURRENCY/);
    expect((await owner("select public.set_prosm_time_external_rate($1, 10, 'EGP', 'FORTNIGHTLY')", [daily])).error).toMatch(/INVALID RATE UNIT/);
    // the new units belong to external workers only
    expect((await t.su("insert into worker_pay_rates (organization_id, user_id, rate_type, rate_amount, currency) values ($1, $2, 'DAILY', 10, 'EGP')", [org.id, managerA.userId]).catch((error) => String(error)))).toMatch(/rate_type_check/);
    const [row] = await t.su<{ currency: string }>("select currency from worker_pay_rates where site_worker_id = $1", [daily]);
    expect(row.currency).toBe("EGP");
  });

  it("are seen only within scope, and never through a payroll permission", async () => {
    const mine = await ok<{ r: { workerId: string }[] }>(t.as(managerA.authId, "select public.list_prosm_time_external_rates() as r"));
    expect(mine.r.map((row) => row.workerId)).not.toContain(atSiteB);
    expect(mine.r.map((row) => row.workerId)).toContain(daily);
    expect((await t.as(managerA.authId, "select public.set_prosm_time_external_rate($1, 999, 'EGP', 'DAILY')", [atSiteB])).error).toMatch(/AUTHORITY REQUIRED/);
    const theirs = await ok<{ r: unknown[] }>(t.as(accountant.authId, "select public.list_prosm_time_external_rates() as r"));
    expect(theirs.r).toEqual([]);
    expect((await t.as(other.owner.authId, "select public.list_prosm_time_external_rates() as r")).rows![0]).toEqual({ r: [] });
  });
});

describe("policy", () => {
  it("is managed by its holder only; fixed amounts need a currency; percentages stay within 100", async () => {
    expect((await t.as(managerA.authId, "select public.save_prosm_time_external_policy_item(null, '{\"name\":\"x\",\"kind\":\"deduction\",\"calc\":\"percent\",\"value\":5}')")).error).toMatch(/AUTHORITY REQUIRED/);
    expect((await owner("select public.save_prosm_time_external_policy_item(null, '{\"name\":\"x\",\"kind\":\"deduction\",\"calc\":\"percent\",\"value\":150}')")).error).toMatch(/100/);
    expect((await owner("select public.save_prosm_time_external_policy_item(null, '{\"name\":\"x\",\"kind\":\"addition\",\"calc\":\"fixed\",\"value\":50}')")).error).toMatch(/CURRENCY/);
    await ok(owner("select public.save_prosm_time_external_policy_item(null, '{\"name\":\"Insurance\",\"kind\":\"deduction\",\"calc\":\"percent\",\"value\":10}')"));
    await ok(owner("select public.save_prosm_time_external_policy_item(null, '{\"name\":\"Transport\",\"kind\":\"addition\",\"calc\":\"fixed\",\"value\":100,\"currency\":\"EGP\"}')"));
  });
});

describe("a pay run", () => {
  it("takes the workers with a rate, suggests daily quantities from the kiosk, and asks for the rest", async () => {
    const created = await ok<{ r: { runId: string; added: number; skipped: unknown[] } }>(owner("select public.create_prosm_time_external_run('2027-05-01', '2027-05-31', null, 'May') as r"));
    runId = created.r.runId;
    expect(created.r.added).toBe(6);
    const dan = await worker(daily);
    expect(dan.attendanceDays).toBe(3);
    expect(Number(dan.quantity)).toBe(3);
    expect((await worker(monthly)).quantity).toBeNull();
    // a second run over the same period does not take the same people again
    const again = await ok<{ r: { added: number; runId: string } }>(owner("select public.create_prosm_time_external_run('2027-05-15', '2027-06-14') as r"));
    expect(again.r.added).toBe(0);
    await ok(owner("select public.transition_prosm_time_external_run($1, 'delete')", [again.r.runId]));
  });

  it("refuses approval until every quantity is in; a quantity unlike the kiosk needs a reason", async () => {
    expect((await owner("select public.transition_prosm_time_external_run($1, 'approve')", [runId])).error).toMatch(/QUANTITY OF EVERY WORKER/);
    const dan = await worker(daily);
    expect((await owner("select public.set_prosm_time_external_quantity($1, 4)", [dan.runWorkerId])).error).toMatch(/REASON IS REQUIRED/);
    await ok(owner("select public.set_prosm_time_external_quantity($1, 4, 'worked Saturday off the kiosk')", [dan.runWorkerId]));
    for (const [id, quantity] of [[monthly, 1], [yearly, 1], [weekly, 4], [usd, 2], [atSiteB, 5]] as const) {
      await ok(owner("select public.set_prosm_time_external_quantity($1, $2, 'counted by the foreman')", [(await worker(id)).runWorkerId, quantity]));
    }
  });

  it("applies the policy before approval: percent of gross, fixed in the worker's currency only", async () => {
    const dan = await worker(daily);
    expect(Number(dan.gross)).toBe(2000);
    expect(dan.policyLines.map((line) => [line.name, Number(line.amount)])).toEqual([["Insurance", 200], ["Transport", 100]]);
    expect(Number(dan.net)).toBe(1900);
    const dina = await worker(usd);
    expect(dina.policyLines.map((line) => line.name)).toEqual(["Insurance"]);
    expect(Number(dina.net)).toBe(72);
  });

  it("takes individual adjustments with a reason: days for daily and (by the rule) monthly/yearly rates, amounts otherwise", async () => {
    const dan = await worker(daily);
    expect((await owner("select public.add_prosm_time_external_adjustment($1, 'deduction', 'quantity', 0.5, '')", [dan.runWorkerId])).error).toMatch(/REASON/);
    await ok(owner("select public.add_prosm_time_external_adjustment($1, 'deduction', 'quantity', 0.5, 'left at noon')", [dan.runWorkerId]));
    await ok(owner("select public.add_prosm_time_external_adjustment($1, 'addition', 'quantity', 1, 'bonus day')", [(await worker(monthly)).runWorkerId]));
    await ok(owner("select public.add_prosm_time_external_adjustment($1, 'addition', 'quantity', 1, 'bonus day')", [(await worker(yearly)).runWorkerId]));
    expect((await owner("select public.add_prosm_time_external_adjustment($1, 'deduction', 'quantity', 1, 'late')", [(await worker(weekly)).runWorkerId])).error).toMatch(/AS AN AMOUNT/);
    await ok(owner("select public.add_prosm_time_external_adjustment($1, 'deduction', 'amount', 75, 'damaged tool')", [(await worker(weekly)).runWorkerId]));
    const after = await worker(daily);
    expect(after.adjustments.map((row) => Number(row.amount))).toEqual([250]);
    expect(Number(after.net)).toBe(1650);
    // monthly 9000 / 30 = 300 a day; yearly 120000 / 12 / 30 = 333.33
    expect((await worker(monthly)).adjustments.map((row) => Number(row.amount))).toEqual([300]);
    expect((await worker(yearly)).adjustments.map((row) => Number(row.amount))).toEqual([333.33]);
  });

  it("keeps a manager to their own site", async () => {
    const seen = await run(managerA.authId);
    expect(seen.workers.map((row) => row.workerId)).not.toContain(atSiteB);
    const basem = (await run()).workers.find((row) => row.workerId === atSiteB)!;
    expect((await t.as(managerA.authId, "select public.add_prosm_time_external_adjustment($1, 'addition', 'amount', 10, 'tip please')", [basem.runWorkerId])).error).toMatch(/AUTHORITY REQUIRED/);
    expect((await t.as(managerA.authId, "select public.transition_prosm_time_external_run($1, 'approve')", [runId])).error).toMatch(/AUTHORITY REQUIRED/);
    expect((await t.as(accountant.authId, "select public.get_prosm_time_external_run($1)", [runId])).error).toMatch(/AUTHORITY REQUIRED/);
  });

  it("keeps totals per currency", async () => {
    const totals = (await run()).totals;
    expect(totals.map((row) => row.currency)).toEqual(["EGP", "USD"]);
    expect(Number(totals.find((row) => row.currency === "USD")!.net)).toBe(72);
  });

  it("freezes on approval: later rate or policy changes do not move it, and nothing changes without a reopen", async () => {
    await ok(owner("select public.transition_prosm_time_external_run($1, 'approve')", [runId]));
    const before = await run();
    expect(before.run.isDraft).toBe(false);
    await ok(owner("select public.save_prosm_time_external_policy_item(null, '{\"name\":\"Late fee\",\"kind\":\"deduction\",\"calc\":\"fixed\",\"value\":999,\"currency\":\"EGP\"}')"));
    expect((await owner("select public.set_prosm_time_external_rate($1, 900, 'EGP', 'DAILY', '2027-05-10')", [daily])).error).toMatch(/APPROVED PAY RUN/);
    expect(await run()).toEqual(before);
    const dan = before.workers.find((row) => row.workerId === daily)!;
    expect((await owner("select public.set_prosm_time_external_quantity($1, 5, 'more')", [dan.runWorkerId])).error).toMatch(/REOPEN/);
    expect((await owner("select public.transition_prosm_time_external_run($1, 'reopen')", [runId])).error).toMatch(/REASON/);
    await ok(owner("select public.transition_prosm_time_external_run($1, 'reopen', 'quantity correction')", [runId]));
    const reopened = await run();
    expect(reopened.run.isDraft).toBe(true);
    expect(reopened.run.runVersion).toBe(2);
    expect(reopened.workers.find((row) => row.workerId === daily)!.policyLines.map((line) => line.name)).toContain("Late fee");
  });

  it("keeps everything in the action log, and stays out of payroll", async () => {
    const actions = (await t.su<{ action: string }>("select distinct action from audit_logs where organization_id = $1 and action like 'EXTERNAL_%'", [org.id])).map((row) => row.action);
    for (const action of ["EXTERNAL_WORKER_RATE_SET", "EXTERNAL_LABOR_POLICY_CHANGED", "EXTERNAL_PAY_RUN_CREATED", "EXTERNAL_PAY_QUANTITY_SET",
      "EXTERNAL_PAY_ADJUSTMENT_ADDED", "EXTERNAL_PAY_RUN_APPROVE", "EXTERNAL_PAY_RUN_REOPEN"]) {
      expect(actions).toContain(action);
    }
    const [{ n }] = await t.su<{ n: number }>("select count(*)::int as n from payroll_cycle_employees where organization_id = $1", [org.id]);
    expect(n).toBe(0);
    expect((await owner("select public.log_prosm_time_external_export($1, 'xlsx', 6) as r", [runId])).error).toBeNull();
  });
});
