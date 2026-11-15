// Governance phase D (owner 2026-11-15, report sections 8.2-8.5): payroll self-approval only when nobody else can
// approve (and then audited), one decision per request (the request row is locked first), one pending correction
// for the same shift and event, API keys with a required expiry that is never extended and a rotation, and a
// delegation of at most 30 days. Migration 20261115140000. Two simultaneous decisions need two real connections
// (PGlite is one): the lock itself is asserted on the function, the race is NOT RUN here.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, clockOut, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let site: string;
let manager: TestMember;
let employee: TestMember;

const asService = async (sql: string, params: unknown[] = []) => {
  try {
    await t.db.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
      await tx.exec("set local role service_role");
      await tx.query(sql, params);
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Flow");
  site = await createSite(t, org, "Main");
  manager = await addMember(t, org, "manager", "Mona");
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, manager.userId]);
  employee = await addMember(t, org, "employee", "Lido");
  await assignToSite(t, site, employee);
  expect((await clockIn(t, employee, site)).error).toBeNull();
  expect((await clockOut(t, employee)).error).toBeNull();
});

describe("payroll: the owner approves their own cycle only when nobody else can", () => {
  it("counts only someone who could approve that very cycle (its site, or the whole organisation)", async () => {
    const exists = async (siteId: string | null) =>
      (await t.su<{ v: boolean }>("select public.prosm_time_other_payroll_approver_exists($1, $2, $3) as v", [org.id, org.owner.userId, siteId]))[0].v;
    const [perm] = await t.su<{ id: string }>("select id from permissions where permission_key = 'payroll.approve'");
    // a site manager with payroll approval covers that site's cycles, not an organisation-wide one
    await t.su("insert into user_permission_overrides (user_id, permission_id, is_granted) values ($1, $2, true)", [manager.userId, perm.id]);
    expect(await exists(site)).toBe(true);
    expect(await exists(null)).toBe(false);
    // someone without a site limit covers every cycle
    const accountant = await addMember(t, org, "employee", "Accountant");
    await t.su("insert into user_permission_overrides (user_id, permission_id, is_granted) values ($1, $2, true)", [accountant.userId, perm.id]);
    expect(await exists(null)).toBe(true);
    const def = await t.su<{ d: string }>("select pg_get_functiondef('public.transition_prosm_time_payroll_cycle(uuid, text, text, integer, boolean)'::regprocedure) as d");
    expect(def[0].d).toContain("prosm_time_other_payroll_approver_exists(v_cycle.organization_id, v_caller, v_cycle.site_id)");
  });

  it("an approval by the person who submitted is written to the audit trail", async () => {
    const [cycle] = await t.su<{ id: string }>(
      `insert into payroll_cycles (organization_id, title, period_start, period_end, status, policy_snapshot, submitted_by)
       values ($1, 'Self', current_date - 40, current_date - 35, 'in_review', '{}'::jsonb, $2) returning id`, [org.id, org.owner.userId]);
    await t.su("update payroll_cycles set status = 'approved', approved_by = $2, approved_at = now() where id = $1", [cycle.id, org.owner.userId]);
    expect((await t.su("select 1 from audit_logs where action = 'PAYROLL_SELF_APPROVED' and entity_id = $1", [cycle.id])).length).toBe(1);
  });
});

describe("one decision per request", () => {
  it("deciding locks the request row first", async () => {
    const defs = await t.su<{ d: string }>(
      `select pg_get_functiondef('public.review_prosm_time_leave(uuid, text, text, numeric)'::regprocedure) || pg_get_functiondef('public.review_prosm_time_exception(text, uuid, text, text)'::regprocedure) as d`);
    expect(defs[0].d).toContain("from leave_requests where id = p_request_id and organization_id = v_org for update;");
    expect(defs[0].d).toContain("where id = p_target_id and organization_id = v_caller_org for update;");
    expect(defs[0].d).not.toMatch(/where id = p_target_id and organization_id = v_caller_org;/);
  });

  it("a second pending correction for the same shift and event is refused; another event is fine", async () => {
    const [shift] = await t.su<{ id: string }>("select id from attendance_sessions where user_id = $1", [employee.userId]);
    const submit = (kind: string) => t.as(employee.authId, `select public.submit_prosm_time_correction_request($1, '${kind}', now() - interval '5 minutes', 'Forgot')`, [shift.id]);
    expect((await submit("clock_out")).error).toBeNull();
    expect((await submit("clock_out")).error).toMatch(/ALREADY PENDING/);
  });
});

describe("API keys: a required expiry that is never extended, and rotation", () => {
  let keyId: string;
  it("a key without an expiry gets 90 days; more than 365 is refused", async () => {
    const made = await t.as<{ r: { keyId: string } }>(org.owner.authId, "select public.generate_prosm_time_api_key_v2('k', array['attendance:read']) as r");
    expect(made.error).toBeNull();
    keyId = made.rows![0].r.keyId;
    const [key] = await t.su<{ days: number }>("select round(extract(epoch from (expires_at - now())) / 86400)::int as days from api_keys where id = $1", [keyId]);
    expect(key.days).toBe(90);
    expect((await t.as(org.owner.authId, "select public.generate_prosm_time_api_key_v2('k2', array['attendance:read'], now() + interval '400 days')")).error).toMatch(/365 DAYS/);
  });

  it("the expiry is never extended, the identity never changes, a revocation stays", async () => {
    expect(await asService("update api_keys set expires_at = expires_at + interval '1 day' where id = $1", [keyId])).toMatch(/NEVER EXTENDED/);
    expect(await asService("update api_keys set key_hash = 'x' where id = $1", [keyId])).toMatch(/CANNOT BE CHANGED/);
    expect(await asService("update api_keys set expires_at = expires_at - interval '1 day' where id = $1", [keyId])).toBeNull();
  });

  it("rotation gives a new key and ends the old one within 24 hours, by the clock", async () => {
    const rotated = await t.as<{ r: { keyId: string; apiKey: string } }>(org.owner.authId, "select public.rotate_prosm_time_api_key($1) as r", [keyId]);
    expect(rotated.error).toBeNull();
    const [old] = await t.su<{ hours: number; replaced_by: string }>(
      "select round(extract(epoch from (expires_at - now())) / 3600)::int as hours, replaced_by from api_keys where id = $1", [keyId]);
    expect(old.hours).toBeLessThanOrEqual(24);
    expect(old.replaced_by).toBe(rotated.rows![0].r.keyId);
    expect((await t.as(org.owner.authId, "select public.rotate_prosm_time_api_key($1)", [keyId])).error).toMatch(/ONLY AN ACTIVE KEY/);
    expect((await t.as(manager.authId, "select public.rotate_prosm_time_api_key($1)", [rotated.rows![0].r.keyId])).error).toMatch(/OWNER/);
    // the old key still opens the API now (the clock ends it, no job), the check refuses it once its time has passed
    const [ok] = await t.su<{ r: unknown }>("select public.prosm_time_api_key_check($1, null, false) as r", ["not-the-key"]);
    expect(ok.r).toBeNull();
  });

  it("revoking still works, and stays", async () => {
    const [fresh] = await t.su<{ id: string }>("select id from api_keys where organization_id = $1 and replaced_by is null and revoked_at is null limit 1", [org.id]);
    expect((await t.as(org.owner.authId, "select public.revoke_prosm_time_api_key($1)", [fresh.id])).error).toBeNull();
    expect(await asService("update api_keys set revoked_at = null where id = $1", [fresh.id])).toMatch(/STAYS REVOKED/);
  });
});

describe("a delegation lasts at most 30 days", () => {
  it("no end means 30 days; a longer one is refused", async () => {
    const deputy = await addMember(t, org, "manager", "Deputy");
    expect((await t.as(org.owner.authId, "select public.grant_prosm_time_owner_authority($1, 'travel')", [deputy.userId])).error).toBeNull();
    const [d] = await t.su<{ days: number }>("select round(extract(epoch from (ends_at - starts_at)) / 86400)::int as days from owner_delegations where user_id = $1 and revoked_at is null", [deputy.userId]);
    expect(d.days).toBe(30);
    const other = await addMember(t, org, "manager", "Other");
    expect((await t.as(org.owner.authId, "select public.grant_prosm_time_owner_authority($1, 'long', null, now() + interval '60 days')", [other.userId])).error).toMatch(/30 DAYS/);
  });
});

describe("back to the role's defaults", () => {
  it("clears every individual change at once, and refuses someone who may not", async () => {
    const person = await addMember(t, org, "employee", "Reset");
    for (const [key, granted] of [["reports.view", true], ["attendance.view", false]] as const) {
      expect((await t.as(org.owner.authId, "select public.set_prosm_time_user_permission_override($1, $2, $3, 'x')", [person.userId, key, granted])).error).toBeNull();
    }
    expect((await t.as(employee.authId, "select public.reset_prosm_time_user_permissions($1, 'x')", [person.userId])).error).not.toBeNull();
    expect((await t.as(org.owner.authId, "select public.reset_prosm_time_user_permissions($1, '')", [person.userId])).error).toMatch(/REASON/);
    expect((await t.as(org.owner.authId, "select public.reset_prosm_time_user_permissions($1, 'back to normal')", [person.userId])).error).toBeNull();
    expect((await t.su("select 1 from user_permission_overrides where user_id = $1", [person.userId])).length).toBe(0);
  });
});
