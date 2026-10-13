// Audit 2026-10-12, item 2.5 - a new database (supabase db reset, a new
// staging project, disaster recovery from Git) must build from every
// migration with no error. Verification scripts that need production
// data skip themselves; new ones belong in supabase/tests/, never in
// supabase/migrations/.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";

describe("fresh database", () => {
  it("applies every migration without an error", async () => {
    const t = await buildDatabase();
    expect(t.failures).toEqual([]);
  });
});
