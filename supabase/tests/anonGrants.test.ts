// Audit 2026-10-12, item 5.1 - no public function may be executable by
// anon (no session) unless it is listed here on purpose, with a reason.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";

// name(argument types) -> why an anonymous caller needs it
const ANON_ALLOWED: Record<string, string> = {};

describe("anon function grants", () => {
  it("no public function is executable by anon outside the allow-list", async () => {
    const t = await buildDatabase();
    const rows = await t.su<{ signature: string }>(
      `select p.oid::regprocedure::text as signature
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prokind = 'f' and has_function_privilege('anon', p.oid, 'execute')
       order by 1`,
    );
    expect(rows.map((row) => row.signature).filter((signature) => !(signature in ANON_ALLOWED))).toEqual([]);
  });
});
