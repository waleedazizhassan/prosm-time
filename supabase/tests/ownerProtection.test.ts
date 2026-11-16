// Governance phase A (owner 2026-11-15, report section 14.4): the real owner is protected on every path.
// A full deputy acts as the owner but never on the owner; a direct write - as service_role, or even as the
// table owner - cannot deactivate, demote, move or delete the owner either. The organisation's own deletion
// and the licence sync (the owner's e-mail) keep working. Migration 20261115100000.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let deputy: TestMember;
let worker: TestMember;

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
const asSuperuser = async (sql: string, params: unknown[] = []) => {
  try {
    await t.su(sql, params);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};
const ownerRow = async () =>
  (await t.su<{ is_active: boolean; is_owner: boolean; role_key: string; email: string }>(
    "select u.is_active, u.is_owner, r.role_key, u.email from users u join roles r on r.id = u.role_id where u.id = $1",
    [org.owner.userId],
  ))[0];

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Guarded");
  deputy = await addMember(t, org, "manager", "Deputy");
  worker = await addMember(t, org, "employee", "Worker");
  const grant = await t.as(org.owner.authId, "select public.grant_prosm_time_owner_authority($1, 'travelling')", [deputy.userId]);
  expect(grant.error).toBeNull();
});

describe("a full deputy acts as the owner, never on the owner", () => {
  it("cannot deactivate the owner", async () => {
    expect((await t.as(deputy.authId, "select public.deactivate_prosm_time_employee($1, 'take over')", [org.owner.userId])).error).toMatch(/OWNER/);
    expect((await ownerRow()).is_active).toBe(true);
  });

  it("cannot authorize or carry out the owner's removal", async () => {
    expect((await t.as(deputy.authId, "select public.authorize_prosm_time_employee_removal($1)", [org.owner.userId])).error).toMatch(/OWNER/);
    expect(await asService("select public.remove_prosm_time_employee($1, $2, 'x')", [org.owner.userId, deputy.userId])).toMatch(/OWNER/);
  });

  it("cannot reactivate or delete the data of the owner", async () => {
    expect((await t.as(deputy.authId, "select public.reactivate_prosm_time_employee($1)", [org.owner.userId])).error).toMatch(/OWNER/);
    expect((await t.as(deputy.authId, "select public.authorize_prosm_time_employee_data_deletion($1)", [org.owner.userId])).error).not.toBeNull();
  });

  it("cannot change the owner's role or permissions", async () => {
    expect((await t.as(deputy.authId, "select public.change_prosm_time_user_role($1, 'employee', 'x')", [org.owner.userId])).error).not.toBeNull();
    expect((await t.as(deputy.authId, "select public.set_prosm_time_user_permission_override($1, 'payroll.view', false, 'x')", [org.owner.userId])).error).toMatch(/OWNER/);
    expect((await ownerRow()).role_key).toBe("owner");
  });

  it("still manages everyone else", async () => {
    expect((await t.as(deputy.authId, "select public.deactivate_prosm_time_employee($1, 'left')", [worker.userId])).error).toBeNull();
    expect((await t.as(deputy.authId, "select public.reactivate_prosm_time_employee($1)", [worker.userId])).error).toBeNull();
  });
});

describe("no direct write reaches the owner's row", () => {
  it("service_role cannot deactivate, demote, move or un-own the owner", async () => {
    const employeeRole = (await t.su<{ id: string }>("select id from roles where role_key = 'employee'"))[0].id;
    expect(await asService("update users set is_active = false where id = $1", [org.owner.userId])).toMatch(/OWNER/);
    expect(await asService("update users set role_id = $2 where id = $1", [org.owner.userId, employeeRole])).toMatch(/OWNER/);
    expect(await asService("update users set is_owner = false where id = $1", [org.owner.userId])).toMatch(/OWNER/);
    expect(await asService("delete from users where id = $1", [org.owner.userId])).toMatch(/OWNER/);
  });

  it("the table owner (superuser) is refused by the trigger too", async () => {
    expect(await asSuperuser("update users set is_active = false where id = $1", [org.owner.userId])).toMatch(/OWNER/);
    expect(await asSuperuser("delete from users where id = $1", [org.owner.userId])).toMatch(/OWNER/);
    expect(await asSuperuser("update users set is_owner = true where id = $1", [worker.userId])).toMatch(/OWNER/);
    expect(await ownerRow()).toMatchObject({ is_active: true, is_owner: true, role_key: "owner" });
  });

  it("a permission override on the owner is refused even when written directly", async () => {
    const [perm] = await t.su<{ id: string }>("select id from permissions where permission_key = 'payroll.view'");
    expect(await asSuperuser("insert into user_permission_overrides (user_id, permission_id, is_granted) values ($1, $2, false)", [org.owner.userId, perm.id])).toMatch(/OWNER/);
  });

  it("nobody else changes the owner's e-mail; the owner and the licence sync (no user session) do", async () => {
    expect((await t.as(deputy.authId, "update users set email = 'thief@x.local' where id = $1", [org.owner.userId])).error).not.toBeNull();
    expect(await asService("update users set email = 'licence@x.local' where id = $1", [org.owner.userId])).toBeNull();
    expect((await ownerRow()).email).toBe("licence@x.local");
  });

  it("the organisation's own deletion still removes its owner", async () => {
    const other = await createOrg(t, "Closing");
    const error = await asSuperuser("delete from organizations where id = $1", [other.id]);
    expect(error).toBeNull();
    expect((await t.su("select 1 from users where id = $1", [other.owner.userId])).length).toBe(0);
  });

  it("authenticated has no direct write on users, owner_delegations or user_permission_overrides", async () => {
    const rows = await t.su<{ t: string; p: string }>(
      `select t, p from unnest(array['public.users','public.owner_delegations','public.user_permission_overrides']) t,
              unnest(array['INSERT','UPDATE','DELETE']) p where has_table_privilege('authenticated', t, p)`,
    );
    expect(rows).toEqual([]);
  });
});

describe("Edge Functions: every auth.admin call is a known, reviewed path", () => {
  // report section 14.4, layer 4. A new auth.admin call must be reviewed and added here on purpose.
  const reviewed = new Set([
    "activate-organization:createUser", "activate-organization:deleteUser",
    "invite-user:createUser", "invite-user:deleteUser",
    "delete-my-account:updateUserById", "delete-my-account:signOut",
    "redeem-invitation:updateUserById", "reset-password:updateUserById",
    "remove-employee:deleteUser", "_shared:updateUserById",
  ]);
  it("has no unreviewed auth.admin call", () => {
    const root = join(__dirname, "..", "functions");
    const found = new Set<string>();
    for (const dir of readdirSync(root)) {
      const path = join(root, dir);
      if (!statSync(path).isDirectory()) continue;
      for (const file of readdirSync(path).filter((name) => name.endsWith(".ts"))) {
        for (const match of readFileSync(join(path, file), "utf8").matchAll(/auth\.admin\.(\w+)/g)) found.add(`${dir}:${match[1]}`);
      }
    }
    expect([...found].filter((call) => !reviewed.has(call))).toEqual([]);
  });
});
