// 2026-11-09 integration API v1b (migration 20261109160000): webhooks through an outbox - only
// with the plan and a matching active endpoint; events in the same transaction as the change;
// claim, retry with growing waits, dead after 8 attempts, redeliver; auto-disable; owner only.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let manager: TestMember;
let site: string;
let endpointId = "";

async function ok<T>(result: Promise<{ rows: T[] | null; error: string | null }>): Promise<T> {
  const { rows, error } = await result;
  if (error) throw new Error(error);
  return rows![0];
}
const owner = (sql: string, params: unknown[] = []) => t.as(org.owner.authId, sql, params);
const outbox = async (type: string) => t.su<{ payload: Record<string, unknown> }>("select payload from webhook_outbox where organization_id = $1 and event_type = $2", [org.id, type]);
type Claimed = { id: string; attempts: number; url: string; secret: string; body: { type: string; data: Record<string, unknown> } }[];
const claim = async () => (await t.su<{ r: Claimed }>("select public.prosm_time_webhook_claim(50) as r"))[0].r;

beforeAll(async () => {
  t = await buildDatabase();
  expect(t.failures).toEqual([]);
  org = await createOrg(t, "Hook Co");
  site = await createSite(t, org, "Main");
  manager = await addMember(t, org, "manager", "Hook Manager");
});

describe("webhooks", () => {
  it("need the plan, the real owner and an https address", async () => {
    // every plan includes the API since 2026-11-09 (migration 20261109210000); start without it
    await t.su("update plans set feature_flags = feature_flags - 'integrations'");
    expect((await owner("select public.create_prosm_time_webhook('https://erp.example.com/hook', array['employee.created'])")).error).toMatch(/FEATURE NOT IN PLAN/);
    await t.su("update plans set feature_flags = feature_flags || '{\"integrations\": true}'::jsonb");
    expect((await t.as(manager.authId, "select public.create_prosm_time_webhook('https://erp.example.com/hook', array['employee.created'])")).error).toMatch(/OWNER/);
    expect((await owner("select public.create_prosm_time_webhook('http://erp.example.com/hook', array['employee.created'])")).error).toMatch(/https/);
    expect((await owner("select public.create_prosm_time_webhook('https://erp.example.com/hook', array['payroll.paid'])")).error).toMatch(/VALID EVENTS/);
    // 2026-11-09 hardening: public HTTPS on 443 only
    for (const bad of ["https://10.0.0.5/hook", "https://192.168.1.4/hook", "https://localhost/hook", "https://printer.local/hook", "https://erp.example.com:8443/hook", "https://169.254.169.254/latest"]) {
      expect((await owner("select public.create_prosm_time_webhook($1, array['employee.created'])", [bad])).error, bad).toMatch(/PUBLIC HTTPS ADDRESS/);
    }
    const created = await ok<{ r: { id: string; secret: string } }>(owner(
      "select public.create_prosm_time_webhook('https://erp.example.com/hook', array['employee.created', 'attendance.clock_in', 'attendance.clock_out', 'leave.approved']) as r"));
    expect(created.r.secret).toMatch(/^whsec_/);
    endpointId = created.r.id;
    const listed = await ok<{ r: { id: string; secretPrefix: string }[] }>(owner("select public.list_prosm_time_webhooks() as r"));
    expect(JSON.stringify(listed.r)).not.toContain(created.r.secret);
  });

  it("write events with the change, only for the events chosen, with ids and states only", async () => {
    const worker = await addMember(t, org, "employee", "New Hire");
    expect((await outbox("employee.created")).map((e) => e.payload.employeeId)).toEqual([worker.userId]);
    await t.su("update users set full_name = 'Renamed' where id = $1", [worker.userId]);
    expect(await outbox("employee.updated")).toHaveLength(0);
    await t.su("insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at) values ($1, $2, $3, 'clocked_in', now() - interval '2 hours')", [org.id, worker.userId, site]);
    await t.su("update attendance_sessions set status = 'clocked_out', clock_out_at = now() where user_id = $1", [worker.userId]);
    expect(await outbox("attendance.clock_in")).toHaveLength(1);
    const [out] = await outbox("attendance.clock_out");
    expect(Object.keys(out.payload).sort()).toEqual(["attendanceId", "clockInAt", "clockOutAt", "employeeId", "siteId"]);
  });

  it("are claimed once, retried with growing waits, dead after 8 attempts, and sent again on request", async () => {
    const first = await claim();
    expect(first.length).toBe(3);
    expect(first[0].secret).toMatch(/^whsec_/);
    expect((first[0] as unknown as { keyId: string }).keyId).toMatch(/^whsec_/);
    expect(await claim()).toEqual([]);
    const target = first[0].id;
    await t.su("select public.prosm_time_webhook_result($1, 200, null)", [first[1].id]);
    await t.su("select public.prosm_time_webhook_result($1, 500, 'server error')", [target]);
    const [retry] = await t.su<{ status: string; wait: number }>("select status, extract(epoch from (next_attempt_at - now())) as wait from webhook_deliveries where id = $1", [target]);
    expect(retry.status).toBe("pending");
    expect(Number(retry.wait)).toBeGreaterThan(50);
    await t.su("update webhook_deliveries set attempts = 8, status = 'sending' where id = $1", [target]);
    await t.su("select public.prosm_time_webhook_result($1, 0, 'timeout')", [target]);
    expect((await t.su<{ status: string }>("select status from webhook_deliveries where id = $1", [target]))[0].status).toBe("dead");
    expect((await t.as(manager.authId, "select public.redeliver_prosm_time_webhook($1)", [target])).error).toMatch(/OWNER/);
    await ok(owner("select public.redeliver_prosm_time_webhook($1)", [target]));
    expect((await claim()).map((d) => d.id)).toContain(target);
  });

  it("turn an endpoint off after 20 deliveries in a row died", async () => {
    await t.su("update webhook_endpoints set consecutive_failures = 19 where id = $1", [endpointId]);
    const [{ id }] = await t.su<{ id: string }>("select id from webhook_deliveries where endpoint_id = $1 and status = 'sending' limit 1", [endpointId]);
    await t.su("update webhook_deliveries set attempts = 8 where id = $1", [id]);
    await t.su("select public.prosm_time_webhook_result($1, 404, 'not found')", [id]);
    const [e] = await t.su<{ is_active: boolean; disabled_reason: string }>("select is_active, disabled_reason from webhook_endpoints where id = $1", [endpointId]);
    expect(e).toMatchObject({ is_active: false, disabled_reason: "too_many_failures" });
    await addMember(t, org, "employee", "After Off");
    expect(await outbox("employee.created")).toHaveLength(1);
  });

  it("produce nothing without the plan", async () => {
    await ok(owner("select public.set_prosm_time_webhook_active($1, true)", [endpointId]));
    await t.su("update plans set feature_flags = feature_flags - 'integrations'");
    await addMember(t, org, "employee", "No Plan");
    expect(await outbox("employee.created")).toHaveLength(1);
  });

  it("keep data only for its stated time", async () => {
    await t.su("insert into api_request_log (organization_id, method, path, status, created_at) values ($1, 'GET', '/old', 200, now() - interval '91 days'), ($1, 'GET', '/new', 200, now())", [org.id]);
    await t.su("update webhook_outbox set created_at = now() - interval '31 days'");
    await t.su("update webhook_deliveries set status = 'delivered'");
    const r = (await t.su<{ r: { requestLog: number; webhookEvents: number } }>("select public.prosm_time_integration_retention() as r"))[0].r;
    expect(r.requestLog).toBe(1);
    expect(r.webhookEvents).toBeGreaterThan(0);
    expect(await t.su("select id from api_request_log where path = '/new'")).toHaveLength(1);
  });
});
