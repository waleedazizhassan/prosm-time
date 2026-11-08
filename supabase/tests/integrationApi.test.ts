// 2026-11-08 general integration API (migration 20261108150000): keys with several scopes, expiry
// and test/live; one authentication path (revoked, expired, locked, plan, scope); the generic
// read resources with cursor pagination; payroll from locked cycles only; legacy keys keep working.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let other: TestOrg;
let siteId: string;
let worker: TestMember;
let manager: TestMember;
let fullKey = "";
let narrowKey = "";
let keyId = "";

async function ok<T>(result: Promise<{ rows: T[] | null; error: string | null }>): Promise<T> {
  const { rows, error } = await result;
  if (error) throw new Error(error);
  return rows![0];
}
const owner = (sql: string, params: unknown[] = []) => t.as(org.owner.authId, sql, params);
type Auth = { organizationId: string; keyId: string; scopeDenied?: boolean; scopes?: string[] } | null;
const auth = async (raw: string, scope: string | null) => (await t.su<{ r: Auth }>("select public.authenticate_prosm_time_api_key_v1($1, $2) as r", [raw, scope]))[0].r;
const legacy = async (raw: string, scope?: string) =>
  scope
    ? (await t.su<{ r: string | null }>("select public.authenticate_prosm_time_api_key_with_scope($1, $2) as r", [raw, scope]))[0].r
    : (await t.su<{ r: string | null }>("select public.authenticate_prosm_time_api_key($1) as r", [raw]))[0].r;

beforeAll(async () => {
  t = await buildDatabase();
  expect(t.failures).toEqual([]);
  org = await createOrg(t, "Api Co");
  other = await createOrg(t, "Other Co");
  siteId = await createSite(t, org, "Plant");
  worker = await addMember(t, org, "employee", "Worker");
  manager = await addMember(t, org, "manager", "Manager");
  await assignToSite(t, siteId, worker);
  // the owner turns the API on for this plan (no plan includes it since 2026-11-03)
  await t.su("update plans set feature_flags = feature_flags || '{\"integrations\": true}'::jsonb");
});

describe("API keys", () => {
  it("are created by the real owner only, with valid scopes and a future expiry", async () => {
    expect((await t.as(manager.authId, "select public.generate_prosm_time_api_key_v2('erp', array['sites:read'])")).error).toMatch(/OWNER/);
    expect((await owner("select public.generate_prosm_time_api_key_v2('erp', array['root:all'])")).error).toMatch(/INVALID API KEY SCOPE/);
    expect((await owner("select public.generate_prosm_time_api_key_v2('erp', array[]::text[])")).error).toMatch(/AT LEAST ONE SCOPE/);
    expect((await owner("select public.generate_prosm_time_api_key_v2('erp', array['sites:read'], now() - interval '1 day')")).error).toMatch(/FUTURE/);
    const full = await ok<{ r: { apiKey: string; keyId: string } }>(owner(
      "select public.generate_prosm_time_api_key_v2('ERP', array['employees:read','sites:read','attendance:read','leaves:read','payroll:read'], null, 'live') as r"));
    fullKey = full.r.apiKey;
    keyId = full.r.keyId;
    expect(fullKey).toMatch(/^ptime_live_[0-9a-f]{64}$/);
    narrowKey = (await ok<{ r: { apiKey: string } }>(owner("select public.generate_prosm_time_api_key_v2('Sites only', array['sites:read'], now() + interval '30 days', 'test') as r"))).r.apiKey;
    expect(narrowKey).toMatch(/^ptime_test_/);
  });

  it("are stored hashed and listed without the secret", async () => {
    const [row] = await t.su<{ key_hash: string }>("select key_hash from api_keys where id = $1", [keyId]);
    expect(row.key_hash).not.toContain(fullKey);
    const list = await ok<{ r: { keyPrefix: string; scopes: string[] }[] }>(owner("select public.list_prosm_time_api_keys() as r"));
    expect(JSON.stringify(list.r)).not.toContain(fullKey);
    expect(list.r.map((key) => key.scopes.length).sort()).toEqual([1, 5]);
    expect((await t.as(manager.authId, "select public.list_prosm_time_api_keys()")).error).toMatch(/OWNER/);
  });

  it("are refused to signed-in users on the gateway functions", async () => {
    for (const sql of ["select public.authenticate_prosm_time_api_key_v1('x', null)", "select public.api_v1_sites($1, null, 10)",
      "select public.log_prosm_time_api_request(null, null, 'GET', '/x', 200, 1, 'c')"]) {
      expect((await owner(sql, sql.includes("$1") ? [org.id] : [])).error).toMatch(/permission denied/i);
    }
  });
});

describe("authentication", () => {
  it("checks the scope the endpoint needs, and the organisation comes from the key", async () => {
    expect((await auth(fullKey, "payroll:read"))?.organizationId).toBe(org.id);
    expect((await auth(narrowKey, "sites:read"))?.organizationId).toBe(org.id);
    expect((await auth(narrowKey, "employees:read"))?.scopeDenied).toBe(true);
    expect(await auth("ptime_live_wrong_wrong_wrong", null)).toBeNull();
  });

  it("refuses an expired key, a locked organisation, and an organisation whose plan has no API", async () => {
    await t.su("update api_keys set expires_at = now() - interval '1 second' where key_hash = encode(sha256(convert_to($1, 'utf8')), 'hex')", [narrowKey]);
    expect(await auth(narrowKey, "sites:read")).toBeNull();
    await t.su("update license_activation_state set is_trial = true, expires_at = now() - interval '1 minute' where organization_id = $1", [org.id]);
    expect(await auth(fullKey, "sites:read")).toBeNull();
    expect(await legacy(fullKey)).toBeNull();
    await t.su("update license_activation_state set is_trial = false, expires_at = now() + interval '1 year' where organization_id = $1", [org.id]);
    await t.su("update plans set feature_flags = feature_flags - 'integrations'");
    expect(await auth(fullKey, "sites:read")).toBeNull();
    // the legacy export endpoints keep serving the keys already in use
    expect(await legacy(fullKey)).toBe(org.id);
    await t.su("update plans set feature_flags = feature_flags || '{\"integrations\": true}'::jsonb");
  });

  it("keeps legacy keys working with what they could do before", async () => {
    await t.su(
      "insert into api_keys (organization_id, name, key_hash, key_prefix, scope) values ($1, 'old payroll', encode(sha256(convert_to('legacy-payroll-key', 'utf8')), 'hex'), 'leg-', 'payroll:read'), ($1, 'old attendance', encode(sha256(convert_to('legacy-attendance-key', 'utf8')), 'hex'), 'leg-', 'attendance:read')",
      [org.id],
    );
    expect(await legacy("legacy-payroll-key", "payroll:read")).toBe(org.id);
    expect(await legacy("legacy-payroll-key")).toBe(org.id);
    expect(await legacy("legacy-attendance-key")).toBe(org.id);
    expect(await legacy("legacy-attendance-key", "payroll:read")).toBeNull();
  });

  it("stops at once when the key is revoked, and the revoke is in the action log", async () => {
    const spare = (await ok<{ r: { apiKey: string; keyId: string } }>(owner("select public.generate_prosm_time_api_key_v2('spare', array['sites:read']) as r"))).r;
    await ok(owner("select public.revoke_prosm_time_api_key($1)", [spare.keyId]));
    expect(await auth(spare.apiKey, "sites:read")).toBeNull();
    const actions = await t.su<{ action: string }>("select action from audit_logs where entity_name = 'api_keys' and entity_id = $1", [spare.keyId]);
    expect(actions.map((row) => row.action).sort()).toEqual(["API_KEY_CREATED", "API_KEY_REVOKED"]);
  });
});

describe("resources", () => {
  it("pages employees by cursor, own organisation only, email only with the sensitive scope", async () => {
    const first = (await t.su<{ r: { id: string; email?: string }[] }>("select public.api_v1_employees($1, null, 2, false) as r", [org.id]))[0].r;
    expect(first).toHaveLength(2);
    expect(first[0].email).toBeUndefined();
    const rest = (await t.su<{ r: { id: string }[] }>("select public.api_v1_employees($1, $2, 50, false) as r", [org.id, first[1].id]))[0].r;
    const all = [...first, ...rest].map((row) => row.id);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toContain(worker.userId);
    expect(all).not.toContain(other.owner.userId);
    const withEmail = (await t.su<{ r: { email?: string }[] }>("select public.api_v1_employees($1, null, 50, true) as r", [org.id]))[0].r;
    expect(withEmail.every((row) => typeof row.email === "string")).toBe(true);
  });

  it("lists sites and attendance of the organisation", async () => {
    const sites = (await t.su<{ r: { id: string }[] }>("select public.api_v1_sites($1, null, 50) as r", [org.id]))[0].r;
    expect(sites.map((site) => site.id)).toContain(siteId);
    await t.su(
      "insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at, clock_out_at) values ($1, $2, $3, 'clocked_out', now() - interval '9 hours', now() - interval '1 hour')",
      [org.id, worker.userId, siteId],
    );
    const rows = (await t.su<{ r: { employeeId: string; workedMinutes: number }[] }>(
      "select public.api_v1_attendance($1, now() - interval '1 day', now(), null, null, 50) as r", [org.id]))[0].r;
    expect(rows).toHaveLength(1);
    expect(rows[0].employeeId).toBe(worker.userId);
    expect(Number(rows[0].workedMinutes)).toBe(480);
    expect((await t.su<{ r: unknown[] }>("select public.api_v1_attendance($1, now() - interval '1 day', now(), null, null, 50) as r", [other.id]))[0].r).toEqual([]);
  });

  it("gives payroll records of locked cycles only, from the stored version, without the extra allowances", async () => {
    const basic = await ok<{ r: { id: string } }>(owner("select public.save_prosm_time_payroll_component(null, $1) as r",
      [JSON.stringify({ name_ar: "الأساسي", category: "earning", source: "fixed", is_basic: true })]));
    const extra = await ok<{ r: { id: string } }>(owner("select public.save_prosm_time_payroll_component(null, $1) as r",
      [JSON.stringify({ name_ar: "بدل إضافي", category: "allowance", source: "fixed", include_in_net: false, include_in_combined: true })]));
    await ok(owner("select public.save_prosm_time_payroll_profile($1, '{\"currency\": \"EGP\", \"employee_code\": \"E-7\"}')", [worker.userId]));
    await ok(owner("select public.set_prosm_time_payroll_profile_component($1, $2, 8000, null, '2026-01-01')", [worker.userId, basic.r.id]));
    await ok(owner("select public.set_prosm_time_payroll_profile_component($1, $2, 900, null, '2026-01-01')", [worker.userId, extra.r.id]));
    const cycleId = (await ok<{ r: { cycleId: string } }>(owner("select public.create_prosm_time_payroll_cycle('2027-05-01', '2027-05-31') as r"))).r.cycleId;
    const records = async () => (await t.su<{ r: { netSalary: number; lines: { name: string }[]; cycleVersion: number }[] }>(
      "select public.api_v1_payroll_records($1, null, null, 50) as r", [org.id]))[0].r;
    await ok(owner("select public.transition_prosm_time_payroll_cycle($1, 'submit', null, null, true)", [cycleId]));
    await ok(owner("select public.transition_prosm_time_payroll_cycle($1, 'approve')", [cycleId]));
    expect(await records()).toEqual([]);
    await ok(owner("select public.transition_prosm_time_payroll_cycle($1, 'lock')", [cycleId]));
    const locked = await records();
    expect(locked).toHaveLength(1);
    expect(Number(locked[0].netSalary)).toBe(8000);
    expect(locked[0].lines.map((line) => line.name)).toEqual(["الأساسي"]);
    expect(JSON.stringify(locked)).not.toContain("بدل إضافي");
  });
});

describe("request log", () => {
  it("keeps who called what, without payloads", async () => {
    await t.su("select public.log_prosm_time_api_request($1, $2, 'GET', '/v1/sites', 200, 12, 'corr-1')", [org.id, keyId]);
    const list = await ok<{ r: { id: string; requests7d: number }[] }>(owner("select public.list_prosm_time_api_keys() as r"));
    expect(list.r.find((key) => key.id === keyId)?.requests7d).toBe(1);
  });
});
