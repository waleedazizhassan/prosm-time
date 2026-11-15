// Governance phase C (owner 2026-11-15, report section 14.3): a sensitive action needs a recent sign-in, read
// from the signed token's claims (aal, amr) - never from an argument. MFA (aal2 + a recent TOTP) for the owner and
// the payroll / permission holders once the platform turns it on. Both flags start off: nothing changes for
// anyone until then. Migration 20261115130000. The claims are injected the way PostgREST sets them.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let worker: TestMember;

const now = () => Math.floor(Date.now() / 1000);
const asClaims = async (authId: string, extra: Record<string, unknown>, sql: string, params: unknown[] = []) => {
  try {
    const rows = await t.db.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: authId, role: "authenticated", ...extra })]);
      await tx.exec("set local role authenticated");
      return (await tx.query(sql, params)).rows;
    });
    return { rows, error: null as string | null };
  } catch (error) {
    return { rows: null, error: error instanceof Error ? error.message : String(error) };
  }
};
const createKey = (claims: Record<string, unknown>) =>
  asClaims(org.owner.authId, claims, "select public.generate_prosm_time_api_key_v2('k', array['attendance:read'])");
const setFlag = (key: string, on: boolean) => t.su("update platform_settings set value = $2::jsonb where key = $1", [key, on ? "true" : "false"]);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "StepUp");
  worker = await addMember(t, org, "employee", "Worker");
});
beforeEach(async () => {
  await setFlag("step_up_required", false);
  await setFlag("mfa_required", false);
});

describe("with both flags off (today) nothing changes", () => {
  it("an old sign-in still creates a key", async () => {
    expect((await createKey({ aal: "aal1", amr: [{ method: "password", timestamp: now() - 86400 }] })).error).toBeNull();
  });
});

describe("step_up_required: a sign-in at most 10 minutes old", () => {
  beforeEach(() => setFlag("step_up_required", true));

  it("accepts a fresh password sign-in", async () => {
    expect((await createKey({ aal: "aal1", amr: [{ method: "password", timestamp: now() - 30 }] })).error).toBeNull();
  });
  it("refuses one 11 minutes old, a token without amr, and a timestamp from the future", async () => {
    expect((await createKey({ aal: "aal1", amr: [{ method: "password", timestamp: now() - 660 }] })).error).toMatch(/STEP_UP_REQUIRED/);
    expect((await createKey({ aal: "aal1" })).error).toMatch(/STEP_UP_REQUIRED/);
    expect((await createKey({ aal: "aal1", amr: [{ method: "password", timestamp: now() + 600 }] })).error).toMatch(/STEP_UP_REQUIRED/);
  });
  it("does not count other methods (a magic link from long ago, an oauth sign-in)", async () => {
    expect((await createKey({ aal: "aal1", amr: [{ method: "oauth", timestamp: now() - 10 }] })).error).toMatch(/STEP_UP_REQUIRED/);
  });
  it("an argument cannot stand in for the claims", async () => {
    const fn = await t.su<{ args: string }>("select pg_get_function_arguments('public.prosm_time_require_step_up(text)'::regprocedure) as args");
    expect(fn[0].args).toBe("p_action text");
    expect((await t.as(org.owner.authId, "select public.prosm_time_require_step_up('apikey.create')")).error).toMatch(/permission denied/);
  });
});

describe("mfa_required: aal2 and a TOTP at most 10 minutes old, for the owner and payroll/permission holders", () => {
  beforeEach(() => setFlag("mfa_required", true));

  it("refuses the owner with a fresh password only (aal1)", async () => {
    expect((await createKey({ aal: "aal1", amr: [{ method: "password", timestamp: now() - 10 }] })).error).toMatch(/MFA_REQUIRED/);
  });
  it("accepts aal2 with a fresh totp, refuses aal2 with an old one", async () => {
    expect((await createKey({ aal: "aal2", amr: [{ method: "password", timestamp: now() - 4000 }, { method: "totp", timestamp: now() - 20 }] })).error).toBeNull();
    expect((await createKey({ aal: "aal2", amr: [{ method: "totp", timestamp: now() - 700 }] })).error).toMatch(/STEP_UP_REQUIRED/);
  });
  it("tells the app who must use MFA", async () => {
    const owner = await asClaims(org.owner.authId, {}, "select public.get_prosm_time_step_up_policy() as p");
    expect((owner.rows![0] as { p: { mfaRequired: boolean } }).p.mfaRequired).toBe(true);
    const plain = await asClaims(worker.authId, {}, "select public.get_prosm_time_step_up_policy() as p");
    expect((plain.rows![0] as { p: { mfaRequired: boolean } }).p.mfaRequired).toBe(false);
  });
});

describe("the guarded actions and the record of a refusal", () => {
  it("payroll approve, reopen and payslip publishing ask for it", async () => {
    const defs = await t.su<{ d: string }>(
      `select string_agg(pg_get_functiondef(p), ' ') as d from unnest(array[
         'public.transition_prosm_time_payroll_cycle(uuid, text, text, integer, boolean)'::regprocedure,
         'public.publish_prosm_time_payslips(uuid, boolean)'::regprocedure]) p`,
    );
    for (const action of ["payroll.approve", "payroll.reopen", "payroll.publish_payslips"]) {
      expect(defs[0].d).toContain(`prosm_time_require_step_up('${action}')`);
    }
  });
  it("the app records a refusal, once a minute at most", async () => {
    expect((await t.as(org.owner.authId, "select public.record_prosm_time_step_up_denied('apikey.create', 'STEP_UP_REQUIRED')")).error).toBeNull();
    expect((await t.as(org.owner.authId, "select public.record_prosm_time_step_up_denied('apikey.create', 'STEP_UP_REQUIRED')")).error).toBeNull();
    const rows = await t.su("select 1 from audit_logs where action = 'STEP_UP_DENIED' and actor_user_id = $1", [org.owner.userId]);
    expect(rows.length).toBe(1);
    expect((await t.as(org.owner.authId, "select public.record_prosm_time_step_up_denied('x', 'ANYTHING')")).error).toMatch(/INVALID/);
  });
});

describe("deactivating a person ends their sessions", () => {
  it("removes their auth sessions", async () => {
    const leaving = await addMember(t, org, "employee", "Leaving");
    await t.su("insert into auth.sessions (user_id) values ($1)", [leaving.authId]);
    expect((await t.as(org.owner.authId, "select public.deactivate_prosm_time_employee($1, 'left')", [leaving.userId])).error).toBeNull();
    expect((await t.su("select 1 from auth.sessions where user_id = $1", [leaving.authId])).length).toBe(0);
  });
});
