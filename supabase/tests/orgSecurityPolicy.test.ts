// Security per organisation (owner 2026-11-16), migration 20261116160000: the owner switches "confirm your identity"
// and "two-step code" on for their own organisation; it applies to that organisation only; switching it off needs a
// fresh confirmation; only the owner; audited.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let other: TestOrg;
let manager: TestMember;

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
const fresh = { aal: "aal1", amr: [{ method: "password", timestamp: now() - 30 }] };
const old = { aal: "aal1", amr: [{ method: "password", timestamp: now() - 4000 }] };
const createKey = (who: TestOrg, claims: Record<string, unknown>) =>
  asClaims(who.owner.authId, claims, "select public.generate_prosm_time_api_key_v2('k', array['attendance:read'])");
const set = (claims: Record<string, unknown>, stepUp: boolean, mfa: boolean) =>
  asClaims(org.owner.authId, claims, "select public.set_prosm_time_security_policy($1, $2)", [stepUp, mfa]);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "SecureCo");
  other = await createOrg(t, "OtherCo");
  manager = await addMember(t, org, "manager", "Mona");
  await t.su("update platform_settings set value = 'false'::jsonb where key in ('step_up_required', 'mfa_required')");
});

describe("the owner's own switch", () => {
  it("off by default: an old sign-in still works", async () => {
    expect((await createKey(org, old)).error).toBeNull();
  });

  it("only the owner switches it", async () => {
    expect((await asClaims(manager.authId, fresh, "select public.set_prosm_time_security_policy(true, false)")).error).toMatch(/ONLY THE ORGANIZATION OWNER/);
  });

  it("on: this organisation asks for a recent sign-in; another organisation is unaffected", async () => {
    expect((await set(fresh, true, false)).error).toBeNull();
    expect((await createKey(org, old)).error).toMatch(/STEP_UP_REQUIRED/);
    expect((await createKey(org, fresh)).error).toBeNull();
    expect((await createKey(other, old)).error).toBeNull();
  });

  it("two-step on: the owner needs a recent two-step code, a password alone is not enough", async () => {
    expect((await set(fresh, true, true)).error).toBeNull();
    expect((await createKey(org, fresh)).error).toMatch(/MFA_REQUIRED/);
    expect((await createKey(org, { aal: "aal2", amr: [{ method: "totp", timestamp: now() - 20 }] })).error).toBeNull();
  });

  it("switching it off needs a fresh confirmation, and every change is audited", async () => {
    expect((await set(old, false, false)).error).toMatch(/STEP_UP_REQUIRED|MFA_REQUIRED/);
    expect((await set({ aal: "aal2", amr: [{ method: "totp", timestamp: now() - 10 }] }, false, false)).error).toBeNull();
    expect((await createKey(org, old)).error).toBeNull();
    const rows = await t.su("select 1 from audit_logs where action = 'SECURITY_POLICY_CHANGED' and organization_id = $1", [org.id]);
    expect(rows.length).toBe(3);
  });

  it("everyone in the organisation can read the settings (the app shows what applies)", async () => {
    const r = await asClaims(manager.authId, fresh, "select public.get_prosm_time_security_policy() as p");
    expect(r.error).toBeNull();
    expect((r.rows![0] as { p: { stepUp: boolean; canChange: boolean } }).p).toMatchObject({ stepUp: false, canChange: false });
  });
});
