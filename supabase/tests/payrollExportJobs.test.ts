// 2026-11-09 spec 15.11 (migration 20261109130000): bulk payslips as a background job - one serial
// per payslip, scope at start, the worker reads the stored version only, progress and the end
// state, download permission checked each time, retention, and the sweep.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let siteA: string;
let siteB: string;
let managerA: TestMember;
let worker: TestMember;
let cycleId = "";
let jobId = "";
const members: TestMember[] = [];

async function ok<T>(result: Promise<{ rows: T[] | null; error: string | null }>): Promise<T> {
  const { rows, error } = await result;
  if (error) throw new Error(error);
  return rows![0];
}
const owner = (sql: string, params: unknown[] = []) => t.as(org.owner.authId, sql, params);

beforeAll(async () => {
  t = await buildDatabase();
  expect(t.failures).toEqual([]);
  org = await createOrg(t, "Bulk Co");
  // these tests check the payroll arithmetic itself; the statutory deductions (2026-11-09) have their own tests
  await t.su("update payroll_settings set statutory = '{}'::jsonb");
  siteA = await createSite(t, org, "A");
  siteB = await createSite(t, org, "B");
  managerA = await addMember(t, org, "manager", "Manager A");
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [siteA, managerA.userId]);
  await ok(owner("select public.set_prosm_time_user_permission_override($1, 'payroll.export_payslips', true, 'site A payslips')", [managerA.userId]));
  const basic = await ok<{ r: { id: string } }>(owner("select public.save_prosm_time_payroll_component(null, $1) as r", [JSON.stringify({ name_ar: "الأساسي", category: "earning", source: "fixed", is_basic: true })]));
  for (const [i, site] of [siteA, siteA, siteB].entries()) {
    const m = await addMember(t, org, "employee", `Person ${i + 1}`);
    await assignToSite(t, site, m);
    await ok(owner("select public.save_prosm_time_payroll_profile($1, '{\"currency\": \"EGP\"}')", [m.userId]));
    await ok(owner("select public.set_prosm_time_payroll_profile_component($1, $2, 6000, null, '2027-01-01')", [m.userId, basic.r.id]));
    members.push(m);
  }
  worker = members[0];
  cycleId = (await ok<{ r: { cycleId: string } }>(owner("select public.create_prosm_time_payroll_cycle('2027-05-01', '2027-05-31') as r"))).r.cycleId;
});

describe("bulk payslip export", () => {
  it("needs an approved or locked cycle", async () => {
    expect((await owner("select public.start_prosm_time_payroll_export_job($1)", [cycleId])).error).toMatch(/APPROVED OR LOCKED/);
    await ok(owner("select public.transition_prosm_time_payroll_cycle($1, 'submit', null, null, true)", [cycleId]));
    await ok(owner("select public.transition_prosm_time_payroll_cycle($1, 'approve')", [cycleId]));
  });

  it("gives every payslip its own serial and takes only the caller's scope", async () => {
    const started = await ok<{ r: { jobId: string; total: number } }>(t.as(managerA.authId, "select public.start_prosm_time_payroll_export_job($1) as r", [cycleId]));
    expect(started.r.total).toBe(2);
    jobId = started.r.jobId;
    const serials = (await t.su<{ serial_no: string }>("select serial_no from payroll_exports where cycle_id = $1 order by serial_no", [cycleId])).map((r) => Number(r.serial_no));
    expect(serials).toHaveLength(2);
    expect(new Set(serials).size).toBe(2);
    expect((await t.as(managerA.authId, "select public.start_prosm_time_payroll_export_job($1)", [cycleId])).error).toMatch(/ALREADY RUNNING/);
    expect((await t.as(worker.authId, "select public.start_prosm_time_payroll_export_job($1)", [cycleId])).error).toMatch(/AUTHORITY/);
  });

  it("feeds the worker from the stored version, in batches, with progress", async () => {
    const first = (await t.su<{ r: { documents: { serial: number; employee: { net_salary: string; lines: unknown[] } }[] } }>("select public.prosm_time_payroll_export_batch($1, 0, 1) as r", [jobId]))[0].r;
    expect(first.documents).toHaveLength(1);
    expect(Number(first.documents[0].employee.net_salary)).toBe(6000);
    const second = (await t.su<{ r: { documents: unknown[] } }>("select public.prosm_time_payroll_export_batch($1, 1, 10) as r", [jobId]))[0].r;
    expect(second.documents).toHaveLength(1);
    await t.su("select public.prosm_time_payroll_export_progress($1, 2)", [jobId]);
    const listed = await ok<{ r: { status: string; done: number }[] }>(t.as(managerA.authId, "select public.list_prosm_time_payroll_export_jobs($1) as r", [cycleId]));
    expect(listed.r[0]).toMatchObject({ status: "running", done: 2 });
    expect((await t.as(managerA.authId, "select public.prosm_time_payroll_export_batch($1, 0, 1)", [jobId])).error).toMatch(/permission denied/i);
  });

  it("is downloadable only when done, by those allowed, until it expires", async () => {
    expect((await t.as(managerA.authId, "select public.authorize_prosm_time_payroll_export_download($1)", [jobId])).error).toMatch(/NOT AVAILABLE/);
    await t.su("select public.prosm_time_payroll_export_finish($1, $2, null)", [jobId, `${org.id}/${jobId}/payslips.zip`]);
    const path = await ok<{ r: { path: string } }>(t.as(managerA.authId, "select public.authorize_prosm_time_payroll_export_download($1) as r", [jobId]));
    expect(path.r.path).toContain(jobId);
    expect((await t.as(worker.authId, "select public.authorize_prosm_time_payroll_export_download($1)", [jobId])).error).toMatch(/AUTHORITY/);
    await t.su("update payroll_export_jobs set expires_at = now() - interval '1 minute' where id = $1", [jobId]);
    const sweep = (await t.su<{ r: { expired: { id: string }[] } }>("select public.prosm_time_payroll_export_sweep() as r"))[0].r;
    expect(sweep.expired.map((e) => e.id)).toContain(jobId);
    await t.su("select public.prosm_time_payroll_export_expired($1)", [jobId]);
    expect((await t.as(managerA.authId, "select public.authorize_prosm_time_payroll_export_download($1)", [jobId])).error).toMatch(/NOT AVAILABLE/);
  });

  it("a failed job keeps no file and says why", async () => {
    const job = (await ok<{ r: { jobId: string } }>(owner("select public.start_prosm_time_payroll_export_job($1) as r", [cycleId]))).r.jobId;
    await t.su("select public.prosm_time_payroll_export_finish($1, null, 'fonts unavailable')", [job]);
    const [row] = await t.su<{ status: string; storage_path: string | null; error: string }>("select status, storage_path, error from payroll_export_jobs where id = $1", [job]);
    expect(row).toMatchObject({ status: "failed", storage_path: null, error: "fonts unavailable" });
  });
});
