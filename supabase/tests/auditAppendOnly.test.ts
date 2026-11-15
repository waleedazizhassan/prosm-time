// Governance phase A (owner 2026-11-15, report section 14.1): the audit trail is append-only for every
// application role, service_role included, and a trigger refuses even the table owner. No session setting
// opens it. The only changes allowed are the ones a foreign key makes after its parent row is gone: the
// organisation's deletion removes its rows, a removed person's link becomes empty. Migration 20261115110000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let worker: TestMember;
let auditId: string;

const TABLES = ["audit_logs", "sensitive_access_log", "data_deletion_log", "entitlement_events"];

const asRole = async (role: "service_role" | "authenticated", sql: string, params: unknown[] = [], sub?: string) => {
  try {
    await t.db.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(sub ? { sub, role } : { role })]);
      await tx.exec(`set local role ${role}`);
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

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Ledger");
  worker = await addMember(t, org, "employee", "Worker");
  const [row] = await t.su<{ id: string }>(
    "insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, description) values ($1, $2, $3, 'TEST_EVENT', 'users', 'kept') returning id",
    [org.id, org.owner.userId, worker.userId],
  );
  auditId = row.id;
});

describe("the audit trail is append-only", () => {
  it("no application role holds update, delete or truncate on it", async () => {
    const rows = await t.su<{ r: string; tbl: string; p: string }>(
      `select r, tbl, p from unnest(array['anon','authenticated','service_role']) r, unnest($1::text[]) tbl,
              unnest(array['UPDATE','DELETE','TRUNCATE']) p where has_table_privilege(r, 'public.' || tbl, p)`,
      [TABLES],
    );
    expect(rows).toEqual([]);
  });

  it("service_role and the owner's session are refused", async () => {
    expect(await asRole("service_role", "update audit_logs set description = 'x' where id = $1", [auditId])).not.toBeNull();
    expect(await asRole("service_role", "delete from audit_logs where id = $1", [auditId])).not.toBeNull();
    expect(await asRole("authenticated", "delete from audit_logs where id = $1", [auditId], org.owner.authId)).not.toBeNull();
  });

  it("the trigger refuses even the table owner, whatever session setting is used", async () => {
    for (const tbl of TABLES) {
      expect(await asSuperuser(`truncate ${tbl}`)).not.toBeNull();
    }
    expect(await asSuperuser("update audit_logs set description = 'x' where id = $1", [auditId])).toMatch(/APPEND-ONLY/);
    expect(await asSuperuser("delete from audit_logs where id = $1", [auditId])).toMatch(/APPEND-ONLY/);
    await t.su("select set_config('prosm.retention', 'on', false), set_config('prosm.audit_unlock', 'on', false)");
    expect(await asSuperuser("delete from audit_logs where id = $1", [auditId])).toMatch(/APPEND-ONLY/);
    const [row] = await t.su<{ description: string }>("select description from audit_logs where id = $1", [auditId]);
    expect(row.description).toBe("kept");
  });

  it("emptying a link is refused while the person still exists, and with any other change", async () => {
    expect(await asSuperuser("update audit_logs set subject_user_id = null where id = $1", [auditId])).toMatch(/APPEND-ONLY/);
  });
});

describe("what a foreign key does after its parent is gone still works", () => {
  it("removing a person empties their link and keeps the row", async () => {
    const removed = await addMember(t, org, "employee", "Leaving");
    const [row] = await t.su<{ id: string }>(
      "insert into audit_logs (organization_id, actor_user_id, subject_user_id, action, entity_name, description) values ($1, $2, $3, 'TEST_EVENT', 'users', 'about leaving') returning id",
      [org.id, org.owner.userId, removed.userId],
    );
    expect(await asSuperuser("delete from users where id = $1", [removed.userId])).toBeNull();
    const [after] = await t.su<{ subject_user_id: string | null; description: string; actor_user_id: string }>(
      "select subject_user_id, description, actor_user_id from audit_logs where id = $1", [row.id],
    );
    expect(after).toMatchObject({ subject_user_id: null, description: "about leaving", actor_user_id: org.owner.userId });
  });

  it("the regular removal of an employee still works and leaves its record", async () => {
    const leaving = await addMember(t, org, "employee", "Removed");
    const result = await t.as(org.owner.authId, "select public.authorize_prosm_time_employee_removal($1)", [leaving.userId]);
    expect(result.error).toBeNull();
    expect(await asRole("service_role", "select public.remove_prosm_time_employee($1, $2, 'left the company')", [leaving.userId, org.owner.userId])).toBeNull();
    const rows = await t.su("select 1 from audit_logs where action = 'EMPLOYEE_REMOVED' and entity_id = $1", [leaving.userId]);
    expect(rows.length).toBe(1);
  });

  it("deleting a whole organisation removes its audit rows", async () => {
    const other = await createOrg(t, "Gone");
    await t.su("insert into audit_logs (organization_id, action, entity_name, description) values ($1, 'TEST_EVENT', 'x', 'y')", [other.id]);
    expect(await asSuperuser("delete from organizations where id = $1", [other.id])).toBeNull();
    expect((await t.su("select 1 from audit_logs where organization_id = $1", [other.id])).length).toBe(0);
  });
});
