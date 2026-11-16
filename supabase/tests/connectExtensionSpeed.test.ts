// 2026-11-15 (found by the payroll load test): a new person's Connect extension is the smallest free number from 10,
// found quickly - 1,000 people had taken 14 minutes. Migration 20261115160000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;

const extOf = async (userId: string) => (await t.su<{ ext: string }>("select ext from connect_extensions where user_id = $1", [userId]))[0]?.ext;

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Exts");
  await t.su("update license_activation_state set max_users = 0 where organization_id = $1", [org.id]).catch(() => undefined);
});

describe("Connect extensions", () => {
  it("take the smallest free number, reusing a gap", async () => {
    const a = await addMember(t, org, "employee", "A");
    const b = await addMember(t, org, "employee", "B");
    const c = await addMember(t, org, "employee", "C");
    const taken = [await extOf(a.userId), await extOf(b.userId), await extOf(c.userId)].map(Number);
    expect(new Set(taken).size).toBe(3);
    await t.su("delete from connect_extensions where user_id = $1", [b.userId]);
    const d = await addMember(t, org, "employee", "D");
    expect(await extOf(d.userId)).toBe(String(taken[1]));
  });

  it("300 people at once take seconds, each with a distinct number", async () => {
    const started = Date.now();
    await t.su(
      `with a as (insert into auth.users (id, email) select gen_random_uuid(), 'bulk' || g || '@t.local' from generate_series(1, 300) g returning id, email)
       insert into users (auth_user_id, organization_id, role_id, email, full_name, status, is_owner, is_active)
       select a.id, $1, (select id from roles where role_key = 'employee'), a.email, 'E ' || a.email, 'active', false, true from a`, [org.id]);
    expect(Date.now() - started).toBeLessThan(30_000);
    const [{ n, d }] = await t.su<{ n: number; d: number }>("select count(*)::int as n, count(distinct ext)::int as d from connect_extensions where organization_id = $1", [org.id]);
    expect(n).toBe(d);
  });
});
