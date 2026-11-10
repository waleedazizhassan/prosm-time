// Owner 2026-11-08: an employee asks for their payslip by email; an allowed manager sends it
// (migration 20261108140000). The Edge Function send-payslip-email runs claim -> PDF -> email ->
// complete; here the database half is checked: who may ask, who is told, who may send, no double
// sending, the stored version only, retries, and the action log.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let siteA: string;
let siteB: string;
let worker: TestMember; // site A
let colleague: TestMember; // site B
let managerA: TestMember; // payroll for site A
let managerB: TestMember; // payroll for site B
let cycleId = "";
let requestId = "";

async function ok<T>(result: Promise<{ rows: T[] | null; error: string | null }>): Promise<T> {
  const { rows, error } = await result;
  if (error) throw new Error(error);
  return rows![0];
}
const owner = (sql: string, params: unknown[] = []) => t.as(org.owner.authId, sql, params);
type Claim = { r: { attemptId: string; to: string; serial: number; cycle: { cycleVersion: number }; employee: { net_salary: string; lines: { name_ar: string }[] } } };

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Slip Co");
  // these tests check the payroll arithmetic itself; the statutory deductions (2026-11-09) have their own tests
  await t.su("update payroll_settings set statutory = '{}'::jsonb");
  siteA = await createSite(t, org, "A");
  siteB = await createSite(t, org, "B");
  worker = await addMember(t, org, "employee", "Worker");
  colleague = await addMember(t, org, "employee", "Colleague");
  managerA = await addMember(t, org, "manager", "Manager A");
  managerB = await addMember(t, org, "manager", "Manager B");
  await assignToSite(t, siteA, worker);
  await assignToSite(t, siteB, colleague);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager'), ($3, $4, 'manager')", [siteA, managerA.userId, siteB, managerB.userId]);
  for (const manager of [managerA, managerB]) {
    await ok(owner("select public.set_prosm_time_user_permission_override($1, 'payroll.export_payslips', true, 'issue payslips')", [manager.userId]));
  }
  const basic = await ok<{ r: { id: string } }>(owner("select public.save_prosm_time_payroll_component(null, $1) as r",
    [JSON.stringify({ name_ar: "الأساسي", category: "earning", source: "fixed", is_basic: true })]));
  const extra = await ok<{ r: { id: string } }>(owner("select public.save_prosm_time_payroll_component(null, $1) as r",
    [JSON.stringify({ name_ar: "بدل إضافي", category: "allowance", source: "fixed", include_in_net: false, include_in_combined: true })]));
  for (const member of [worker, colleague]) {
    await ok(owner("select public.save_prosm_time_payroll_profile($1, '{\"legal_name\": \"موظف تجريبي\", \"currency\": \"EGP\"}')", [member.userId]));
    await ok(owner("select public.set_prosm_time_payroll_profile_component($1, $2, 8000, null, '2026-01-01')", [member.userId, basic.r.id]));
    await ok(owner("select public.set_prosm_time_payroll_profile_component($1, $2, 900, null, '2026-01-01')", [member.userId, extra.r.id]));
  }
  cycleId = (await ok<{ r: { cycleId: string } }>(owner("select public.create_prosm_time_payroll_cycle('2027-05-01', '2027-05-31') as r"))).r.cycleId;
});

describe("asking for a payslip", () => {
  it("is refused until the payslip is published from a locked cycle", async () => {
    expect((await t.as(worker.authId, "select public.request_prosm_time_payslip($1)", [cycleId])).error).toMatch(/NOT PUBLISHED/);
    await ok(owner("select public.transition_prosm_time_payroll_cycle($1, 'submit', null, null, true)", [cycleId]));
    await ok(owner("select public.transition_prosm_time_payroll_cycle($1, 'approve')", [cycleId]));
    await ok(owner("select public.transition_prosm_time_payroll_cycle($1, 'lock')", [cycleId]));
    await ok(owner("select public.publish_prosm_time_payslips($1, true)", [cycleId]));
  });

  it("shows on My payslips, and tells only the managers allowed for that person", async () => {
    const mine = await ok<{ r: { canViewInApp: boolean; cycles: { cycleId: string }[] } }>(t.as(worker.authId, "select public.list_my_prosm_time_payslip_cycles() as r"));
    expect(mine.r.cycles.map((cycle) => cycle.cycleId)).toEqual([cycleId]);
    expect(mine.r.canViewInApp).toBe(false);
    requestId = (await ok<{ r: { id: string } }>(t.as(worker.authId, "select public.request_prosm_time_payslip($1, 'for the bank') as r", [cycleId]))).r.id;
    expect((await t.as(worker.authId, "select public.request_prosm_time_payslip($1)", [cycleId])).error).toMatch(/ALREADY ASKED/);
    const told = await t.su<{ user_id: string }>("select user_id from notifications where type = 'payslip_requested'");
    const ids = told.map((row) => row.user_id);
    expect(ids).toContain(managerA.userId);
    expect(ids).toContain(org.owner.userId);
    expect(ids).not.toContain(managerB.userId);
    const [note] = await t.su<{ body: string }>("select body from notifications where type = 'payslip_requested' limit 1");
    expect(note.body).not.toMatch(/8000|8,000/);
  });

  it("is the person's own: nobody reads another person's request list", async () => {
    const theirs = await ok<{ r: { cycles: unknown[] } }>(t.as(colleague.authId, "select public.list_my_prosm_time_payslip_cycles() as r"));
    expect(theirs.r.cycles.length).toBe(1);
    expect(await t.as(colleague.authId, "select id from payslip_requests")).toMatchObject({ error: expect.stringMatching(/permission denied/) });
  });
});

describe("sending it", () => {
  it("is refused outside the manager's scope and to the requester", async () => {
    expect((await t.as(managerB.authId, "select public.claim_prosm_time_payslip_email($1)", [requestId])).error).toMatch(/PAYROLL AUTHORITY/);
    expect((await t.as(worker.authId, "select public.claim_prosm_time_payslip_email($1)", [requestId])).error).toMatch(/PAYROLL AUTHORITY/);
    const listB = await ok<{ r: unknown[] }>(t.as(managerB.authId, "select public.list_prosm_time_payslip_requests() as r"));
    expect(listB.r).toEqual([]);
  });

  it("carries the stored version only, and cannot be sent twice at once", async () => {
    // a later profile change does not reach the stored payslip
    await t.su("update payroll_profile_components set amount = 99999 where profile_id = (select id from payroll_profiles where user_id = $1)", [worker.userId]);
    const claim = await ok<Claim>(t.as(managerA.authId, "select public.claim_prosm_time_payslip_email($1) as r", [requestId]));
    expect(Number(claim.r.employee.net_salary)).toBe(8000);
    expect(claim.r.employee.lines.map((line) => line.name_ar)).toEqual(["الأساسي"]);
    expect(claim.r.cycle.cycleVersion).toBe(1);
    expect(claim.r.to).toMatch(/@/);
    expect((await t.as(managerA.authId, "select public.claim_prosm_time_payslip_email($1)", [requestId])).error).toMatch(/BEING SENT/);

    // the email failed: recorded as failed with the error, then retried
    await ok(t.as(managerA.authId, "select public.complete_prosm_time_payslip_email($1, $2, false, 'relay timeout')", [requestId, claim.r.attemptId]));
    const failed = await ok<{ r: { status: string; lastError: string }[] }>(t.as(managerA.authId, "select public.list_prosm_time_payslip_requests() as r"));
    expect(failed.r[0]).toMatchObject({ status: "failed", lastError: "relay timeout" });
    expect((await t.as(managerA.authId, "select public.complete_prosm_time_payslip_email($1, $2, true)", [requestId, claim.r.attemptId])).error).toMatch(/NOT YOURS OR IS OVER/);

    const retry = await ok<Claim>(t.as(managerA.authId, "select public.claim_prosm_time_payslip_email($1) as r", [requestId]));
    expect(retry.r.serial).toBe(Number(claim.r.serial) + 1);
    await ok(t.as(managerA.authId, "select public.complete_prosm_time_payslip_email($1, $2, true)", [requestId, retry.r.attemptId]));
    expect((await t.as(managerA.authId, "select public.claim_prosm_time_payslip_email($1)", [requestId])).error).toMatch(/ALREADY SENT/);

    const mine = await ok<{ r: { cycles: { request: { status: string } }[] } }>(t.as(worker.authId, "select public.list_my_prosm_time_payslip_cycles() as r"));
    expect(mine.r.cycles[0].request.status).toBe("sent");
    expect(await t.su("select id from notifications where type = 'payslip_sent' and user_id = $1", [worker.userId])).toHaveLength(1);
  });

  it("keeps every attempt in the action log", async () => {
    const rows = await t.su<{ action: string; actor_user_id: string; subject_user_id: string; context: Record<string, unknown> }>(
      "select action, actor_user_id, subject_user_id, context from audit_logs where entity_name = 'payslip_requests' and action like 'payroll.payslip_email%' order by created_at");
    expect(rows.map((row) => row.action)).toEqual(["payroll.payslip_email_failed", "payroll.payslip_emailed"]);
    const sent = rows[1];
    expect(sent.actor_user_id).toBe(managerA.userId);
    expect(sent.subject_user_id).toBe(worker.userId);
    expect(sent.context).toMatchObject({ requesterId: worker.userId, senderId: managerA.userId, cycleId, cycleVersion: 1, sent: true });
    expect(String(sent.context.recipientEmail)).toMatch(/@/);
    expect(rows[0].context).toMatchObject({ sent: false, error: "relay timeout" });
  });

  it("closes open requests when the cycle is reopened", async () => {
    const other = (await ok<{ r: { id: string } }>(t.as(colleague.authId, "select public.request_prosm_time_payslip($1) as r", [cycleId]))).r.id;
    await ok(owner("select public.transition_prosm_time_payroll_cycle($1, 'reopen', 'correction')", [cycleId]));
    const [row] = await t.su<{ status: string }>("select status from payslip_requests where id = $1", [other]);
    expect(row.status).toBe("failed");
    expect((await t.as(managerB.authId, "select public.claim_prosm_time_payslip_email($1)", [other])).error).toMatch(/NOT PUBLISHED/);
  });
});

// 2026-11-09 (owner): answered in the app - nothing generated or stored; the person may open that payslip
describe("answering in the app", () => {
  it("lets the colleague open their payslip in the app even with self-service off, once", async () => {
    await t.su("update payroll_settings set employee_self_service = false where organization_id = $1", [org.id]);
    // a fresh, published cycle (the one above was reopened)
    cycleId = (await ok<{ r: { cycleId: string } }>(owner("select public.create_prosm_time_payroll_cycle('2027-06-01', '2027-06-30') as r"))).r.cycleId;
    await ok(owner("select public.transition_prosm_time_payroll_cycle($1, 'submit', null, null, true)", [cycleId]));
    await ok(owner("select public.transition_prosm_time_payroll_cycle($1, 'approve')", [cycleId]));
    await ok(owner("select public.transition_prosm_time_payroll_cycle($1, 'lock')", [cycleId]));
    await ok(owner("select public.publish_prosm_time_payslips($1, true)", [cycleId]));
    const id = (await ok<{ r: { id: string } }>(t.as(colleague.authId, "select public.request_prosm_time_payslip($1) as r", [cycleId]))).r.id;
    expect((await t.as(colleague.authId, "select public.get_my_prosm_time_payslip($1)", [cycleId])).error).toMatch(/NOT AVAILABLE/);
    expect((await t.as(managerA.authId, "select public.send_prosm_time_payslip_in_app($1)", [id])).error).toMatch(/AUTHORITY/);
    await ok(owner("select public.send_prosm_time_payslip_in_app($1)", [id]));
    expect((await t.as(colleague.authId, "select public.get_my_prosm_time_payslip($1)", [cycleId])).error).toBeNull();
    const mine = await ok<{ r: { cycles: { canView: boolean }[] } }>(t.as(colleague.authId, "select public.list_my_prosm_time_payslip_cycles() as r"));
    expect(mine.r.cycles[0].canView).toBe(true);
    expect((await owner("select public.send_prosm_time_payslip_in_app($1)", [id])).error).toMatch(/ALREADY SENT/);
    expect(await t.su("select 1 from notifications where user_id = $1 and type = 'payslip_sent' and data ->> 'channel' = 'app'", [colleague.userId])).toHaveLength(1);
  });
});
