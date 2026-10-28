// v2.3.55 (owner 2026-10-28): an international program - a new organisation's
// leave types name no country's law; their days and rules are unchanged.
// Migration 20261028110000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { createOrg } from "./support/fixtures";

describe("leave types", () => {
  it("are seeded with their days but without law notes", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "World Co");
    const rows = await t.su<{ key: string; annual_days: number | null; legal_note: string | null }>("select key, annual_days, legal_note from leave_types where organization_id = $1", [org.id]);
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.some((row) => (row.legal_note ?? "").includes("Law"))).toBe(false);
    expect(Number(rows.find((row) => row.key === "emergency")?.annual_days)).toBe(7);
  });
});
