// Release gate (owner 2026-11-16: "get ready - the version goes to the public"): the database's security posture,
// checked on the schema every migration builds. Any new table, view or function that breaks a rule fails here.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";

let t: TestDatabase;

beforeAll(async () => {
  t = await buildDatabase();
});

describe("database security posture", () => {
  it("every public table has row level security on", async () => {
    const rows = await t.su<{ name: string }>(
      "select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity order by 1");
    expect(rows.map((r) => r.name)).toEqual([]);
  });

  it("no table or view in public is readable or writable by anonymous visitors", async () => {
    const rows = await t.su<{ name: string; priv: string }>(
      `select c.relname as name, string_agg(p.privilege_type, ',') as priv
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) p
       join pg_roles r on r.oid = p.grantee
       where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm') and r.rolname = 'anon'
       group by 1 order by 1`);
    expect(rows).toEqual([]);
  });

  it("every SECURITY DEFINER function pins its search_path", async () => {
    const rows = await t.su<{ name: string }>(
      `select p.oid::regprocedure::text as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosecdef
         and not exists (select 1 from unnest(coalesce(p.proconfig, array[]::text[])) c where c like 'search_path=%')
       order by 1`);
    expect(rows.map((r) => r.name)).toEqual([]);
  });

  it("anonymous visitors can run only the functions meant for signing in and the public pages", async () => {
    const rows = await t.su<{ name: string }>(
      `select p.oid::regprocedure::text as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prokind = 'f' and has_function_privilege('anon', p.oid, 'execute')
         and p.prosecdef order by 1`);
    // a SECURITY DEFINER function anonymous visitors may call is reviewed one by one: listed here on purpose
    const allowed = new Set<string>([
      // background location while the app is closed: a 32+ character secret key, stored hashed, expiring, used only
      // during an active shift (20261111150000)
      "record_prosm_time_location_by_key(text,double precision,double precision,double precision,timestamp with time zone,boolean)",
    ]);
    const unexpected = rows.map((r) => r.name).filter((n) => !allowed.has(n));
    expect(unexpected).toEqual([]);
  });

  it("views run with the caller's rights (no view bypasses row level security)", async () => {
    const rows = await t.su<{ name: string }>(
      `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'v'
         and not coalesce((select bool_or(o = 'security_invoker=true' or o = 'security_invoker=on') from unnest(c.reloptions) o), false)
       order by 1`);
    expect(rows.map((r) => r.name)).toEqual([]);
  });

  it("only the buckets meant to be public are public", async () => {
    const exists = await t.su<{ ok: boolean }>("select to_regclass('storage.buckets') is not null as ok");
    if (!exists[0].ok) return;
    const rows = await t.su<{ id: string }>("select id from storage.buckets where public order by 1");
    // app downloads; organisation logos (emails, the sign-in page); profile pictures - none can be listed by an
    // anonymous visitor, and a picture's address carries the person's internal id and a time (checked live 2026-11-16)
    expect(rows.map((r) => r.id)).toEqual(["app-releases", "organization-logos", "user-avatars"]);
  });
});
