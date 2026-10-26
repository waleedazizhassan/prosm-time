// v2.3.51 (owner 2026-10-26: "the attendance record could not be loaded"):
// step 2 gave attendance_sessions a second link to users (hours_reviewed_by),
// and the app's "users(full_name)" embed became ambiguous - the API refuses
// it, so the whole Attendance Record failed. This test finds every table pair
// with more than one link and fails when the app embeds one of them without
// naming the link (table!constraint(...)).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("API embeds", () => {
  it("never embed an ambiguous link without naming it", async () => {
    const t = await buildDatabase();
    const pairs = await t.su<{ from_table: string; to_table: string }>(
      `select c.conrelid::regclass::text as from_table, c.confrelid::regclass::text as to_table
       from pg_constraint c
       where c.contype = 'f' and c.connamespace = 'public'::regnamespace
       group by 1, 2 having count(*) > 1`,
    );
    const ambiguous = new Map<string, Set<string>>();
    for (const { from_table, to_table } of pairs) {
      const from = from_table.replace(/^public\./, "");
      const to = to_table.replace(/^public\./, "");
      ambiguous.set(from, (ambiguous.get(from) ?? new Set()).add(to));
    }

    const problems: string[] = [];
    for (const file of sourceFiles(join(process.cwd(), "src"))) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/\.from\("([a-z_]+)"\)\s*\.select\(\s*[`"]([^`"]*)[`"]/g)) {
        const targets = ambiguous.get(match[1]);
        if (!targets) continue;
        for (const target of targets) {
          // an embed of the target without "!constraint": "users(" or "alias:users("
          if (new RegExp(`(^|[\\s,:])${target}\\(`).test(match[2])) problems.push(`${file.replace(process.cwd(), "")}: ${match[1]} -> ${target}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
