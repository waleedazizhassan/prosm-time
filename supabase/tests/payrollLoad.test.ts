// 2026-11-09 spec 15.15 load test: 1,000 employees x 30 lines - create the cycle, recalculate,
// submit, approve (snapshot), and build the summary report - with the measured times printed and
// kept in docs/execution/PAYROLL_LOAD_TEST.md. PGlite is an in-memory single-process Postgres, so
// a real server is faster; the point is that every step stays within reasonable time and memory.
import { writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { createOrg, type TestOrg } from "./support/fixtures";

const PEOPLE = 1000;
const COMPONENTS = 30;
let t: TestDatabase;
let org: TestOrg;
let cycleId = "";
const timings: [string, number][] = [];

async function timed<T>(label: string, task: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await task();
  timings.push([label, Math.round(performance.now() - started)]);
  return result;
}
async function ok<T>(result: Promise<{ rows: T[] | null; error: string | null }>): Promise<T> {
  const { rows, error } = await result;
  if (error) throw new Error(error);
  return rows![0];
}
const owner = (sql: string, params: unknown[] = []) => t.as(org.owner.authId, sql, params);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Load Co");
  // these tests check the payroll arithmetic itself; the statutory deductions (2026-11-09) have their own tests
  await t.su("update payroll_settings set statutory = '{}'::jsonb");
  await t.su("update license_activation_state set max_users = 0 where organization_id = $1", [org.id]);
  await timed("setup: 1,000 employees", () => t.su(
    `with a as (insert into auth.users (id, email) select gen_random_uuid(), 'load' || g || '@test.local' from generate_series(1, ${PEOPLE}) g returning id, email)
     insert into users (auth_user_id, organization_id, role_id, email, full_name, status, is_owner, is_active)
     select a.id, $1, (select id from roles where role_key = 'employee'), a.email, 'Employee ' || a.email, 'active', false, true from a`, [org.id]));
  // 30 components: a basic, 14 more earnings/allowances, 15 deductions
  await t.su(
    `insert into payroll_components (organization_id, name_ar, category, source, is_basic, sort_order)
     select $1, 'بند ' || g, case when g <= 15 then 'earning' else 'deduction' end, 'fixed', g = 1, g from generate_series(1, ${COMPONENTS}) g`, [org.id]);
  await timed("setup: 1,000 profiles x 30 components", async () => {
    await t.su(`insert into payroll_profiles (organization_id, user_id, currency, start_date) select $1, id, 'EGP', '2027-01-01' from users where organization_id = $1 and not is_owner`, [org.id]);
    await t.su(
      `insert into payroll_profile_components (organization_id, profile_id, component_id, amount, effective_from)
       select $1, p.id, c.id, case when c.is_basic then 8000 when c.category = 'earning' then 150 else 40 end, '2027-01-01'
       from payroll_profiles p cross join payroll_components c where p.organization_id = $1 and c.organization_id = $1`, [org.id]);
  });
}, 600_000);

describe("payroll at 1,000 employees x 30 lines", () => {
  it("creates, recalculates, submits, approves and reports within limits", async () => {
    const created = await timed("create the cycle", () => ok<{ r: { cycleId: string } }>(owner("select public.create_prosm_time_payroll_cycle('2027-05-01', '2027-05-31') as r")));
    cycleId = created.r.cycleId;
    const [{ n, lines }] = await t.su<{ n: number; lines: number }>(
      "select count(distinct ce.id)::int as n, count(l.id)::int as lines from payroll_cycle_employees ce join payroll_cycle_lines l on l.cycle_employee_id = ce.id where ce.cycle_id = $1", [cycleId]);
    expect(n).toBe(PEOPLE);
    expect(lines).toBe(PEOPLE * COMPONENTS);
    const [{ v }] = await t.su<{ v: number }>("select row_version as v from payroll_cycles where id = $1", [cycleId]);
    await timed("recalculate", () => ok(owner("select public.recalculate_prosm_time_payroll_cycle($1, $2)", [cycleId, v])));
    await timed("validate", () => ok(owner("select public.validate_prosm_time_payroll_cycle($1)", [cycleId])));
    await timed("submit", () => ok(owner("select public.transition_prosm_time_payroll_cycle($1, 'submit', null, null, true)", [cycleId])));
    await timed("approve (snapshot)", () => ok(owner("select public.transition_prosm_time_payroll_cycle($1, 'approve')", [cycleId])));
    const report = await timed("summary report", () => ok<{ r: { employees: unknown[]; totals: { net: string }[] } }>(owner("select public.get_prosm_time_payroll_report($1, 'summary') as r", [cycleId])));
    expect(report.r.employees).toHaveLength(PEOPLE);
    // net = earnings - deductions: 8000 + 14 x 150 - 15 x 40 = 9500 each
    expect(Number(report.r.totals[0].net)).toBe(PEOPLE * 9500);
    await timed("start the bulk payslip export (1,000 serials)", () => ok(owner("select public.start_prosm_time_payroll_export_job($1) as r", [cycleId])));

    const rows = timings.map(([label, ms]) => `| ${label} | ${ms.toLocaleString("en-US")} ms |`).join("\n");
    console.log(`\nPayroll load test (${PEOPLE} x ${COMPONENTS})\n${rows}\n`);
    writeFileSync(
      "docs/execution/PAYROLL_LOAD_TEST.md",
      `# Payroll load test (spec 15.15)\n\nMeasured ${new Date().toISOString().slice(0, 10)} on PGlite (in-memory, single process - a real Postgres server is faster).\n${PEOPLE} employees x ${COMPONENTS} components (${(PEOPLE * COMPONENTS).toLocaleString("en-US")} lines); net checked: 9,500 per employee.\n\n| Step | Time |\n|---|---|\n${rows}\n\nRun again: \`npx vitest run --config vitest.db.config.ts supabase/tests/payrollLoad.test.ts\`\n`,
    );
    for (const [label, ms] of timings) if (!label.startsWith("setup")) expect(ms, label).toBeLessThan(180_000);
  }, 900_000);
});
