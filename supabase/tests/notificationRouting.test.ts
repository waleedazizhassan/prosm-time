// 2026-11-08 B-10 (every notification is routed correctly, nothing broken or stale): each type the
// database allows must have a destination in the app (notificationTarget.ts), wording in the app
// (localizeNotification.ts) and wording for the phone push (localizePush.ts). A new type added in
// a migration without them fails here.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

let t: TestDatabase;
let types: string[] = [];

beforeAll(async () => {
  t = await buildDatabase();
  const [row] = await t.su<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'notifications_type_check'");
  types = [...row.def.matchAll(/'([a-z_]+)'::text/g)].map((match) => match[1]);
});

describe("notification types", () => {
  it("are read from the database", () => {
    expect(types.length).toBeGreaterThan(10);
  });

  for (const [label, path] of [
    ["has a destination in the app", "src/core/utils/notificationTarget.ts"],
    ["has wording in the app", "src/core/utils/localizeNotification.ts"],
    ["has wording for the phone push", "supabase/functions/_shared/localizePush.ts"],
  ] as const) {
    it(`each ${label}`, () => {
      const text = source(path);
      // notificationTarget routes the timesheet_* and allowance_* families by prefix
      const byPrefix = (type: string) => path.endsWith("notificationTarget.ts") && /^(timesheet|allowance)_/.test(type);
      const missing = types.filter((type) => !byPrefix(type) && !new RegExp(`["'\`]${type}["'\`]`).test(text));
      expect(missing, path).toEqual([]);
    });
  }

  it("each destination is a real page of the app", () => {
    const routes = source("src/routes/AppRoutes.tsx");
    const targets = [...source("src/core/utils/notificationTarget.ts").matchAll(/["'`](\/[a-z-]+(?:\/[a-z-]+)?)/g)].map((match) => match[1]);
    const missing = [...new Set(targets)].filter((path) => !routes.includes(`path="${path}"`));
    expect(missing).toEqual([]);
  });
});
