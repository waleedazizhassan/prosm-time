// Owner 2026-10-20: a shift has exactly one foreign key to sites, so the
// app's "sites(name)" embed from attendance_sessions is never ambiguous
// (PGRST201 emptied the dashboard). Migration 20261020170000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";

let t: TestDatabase;

beforeAll(async () => {
  t = await buildDatabase();
});

describe("shift to site link", () => {
  it("is a single foreign key", async () => {
    const [row] = await t.su<{ n: number }>(
      `select count(*)::int as n from pg_constraint c
       where c.conrelid = 'public.attendance_sessions'::regclass and c.contype = 'f' and c.confrelid = 'public.sites'::regclass`,
    );
    expect(row.n).toBe(1);
  });
});
