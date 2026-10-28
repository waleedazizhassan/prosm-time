// v2.3.57 (owner 2026-10-28, after the security review: "RLS is a living
// system"): every table has row level security, the public key reaches no
// table, and a table created later is locked the moment it exists.
// Migration 20261028120000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";

describe("secure by default", () => {
  it("every public table has RLS on, and the public key holds no table rights", async () => {
    const t = await buildDatabase();
    const open = await t.su<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public' and not rowsecurity");
    expect(open.map((row) => row.tablename)).toEqual([]);
    const anon = await t.su<{ table_name: string }>(
      "select distinct table_name from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public'",
    );
    expect(anon.map((row) => row.table_name)).toEqual([]);
  });

  it("a table created later is locked at once: RLS on, nothing for the public key", async () => {
    const t = await buildDatabase();
    await t.su("create table public.forgotten_table (id int primary key, secret text)");
    const [row] = await t.su<{ rowsecurity: boolean }>("select rowsecurity from pg_tables where schemaname = 'public' and tablename = 'forgotten_table'");
    expect(row.rowsecurity).toBe(true);
    const anon = await t.su<{ n: number }>("select count(*)::int as n from information_schema.role_table_grants where grantee = 'anon' and table_name = 'forgotten_table'");
    expect(anon[0].n).toBe(0);
  });
});
