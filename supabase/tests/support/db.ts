// Builds a throwaway PostgreSQL database (PGlite, in memory) from the
// repo's own migrations, with a minimal stand-in for the parts of
// Supabase they use (supabase-stub.sql, stub_extra.sql), and gives the
// tests helpers to run SQL as the superuser or as a signed-in user under
// the real RLS policies and grants.
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "migrations");

export interface MigrationFailure {
  file: string;
  error: string;
}

export interface TestDatabase {
  db: PGlite;
  failures: MigrationFailure[];
  su: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
  as: <T = Record<string, unknown>>(authUserId: string | null, sql: string, params?: unknown[]) => Promise<{ rows: T[] | null; error: string | null }>;
}

export async function buildDatabase(): Promise<TestDatabase> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(readFileSync(join(here, "supabase-stub.sql"), "utf8"));
  await db.exec(readFileSync(join(here, "stub_extra.sql"), "utf8"));

  const failures: MigrationFailure[] = [];
  const files = readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8").replace(/create extension if not exists (pg_cron|pg_net)[^;]*;/gi, "");
    try {
      await db.exec(sql);
    } catch (error) {
      failures.push({ file, error: error instanceof Error ? error.message : String(error) });
      try {
        await db.exec("rollback");
      } catch {
        // no open transaction
      }
    }
  }

  const su = async <T,>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

  const as = async <T,>(authUserId: string | null, sql: string, params: unknown[] = []) => {
    try {
      const rows = await db.transaction(async (tx) => {
        const claims = authUserId ? { sub: authUserId, role: "authenticated" } : { role: "anon" };
        await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
        await tx.exec(`set local role ${authUserId ? "authenticated" : "anon"}`);
        return (await tx.query<T>(sql, params)).rows;
      });
      return { rows, error: null };
    } catch (error) {
      return { rows: null, error: error instanceof Error ? error.message : String(error) };
    }
  };

  return { db, failures, su, as };
}
