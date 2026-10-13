// Audit 5.3 - the trial-notices secret is compared in constant time.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { secretsMatch } from "../functions/_shared/constantTime";

describe("secretsMatch", () => {
  it("accepts only the exact secret", async () => {
    expect(await secretsMatch("s3cret-value", "s3cret-value")).toBe(true);
    expect(await secretsMatch("s3cret-valuf", "s3cret-value")).toBe(false);
    expect(await secretsMatch("s3cret", "s3cret-value")).toBe(false);
    expect(await secretsMatch("", "s3cret-value")).toBe(false);
    expect(await secretsMatch(null, "s3cret-value")).toBe(false);
    expect(await secretsMatch("anything", undefined)).toBe(false);
  });

  it("is what send-trial-notices uses, with no plain comparison left", () => {
    const source = readFileSync(new URL("../functions/send-trial-notices/index.ts", import.meta.url), "utf8");
    expect(source).toContain('secretsMatch(request.headers.get("x-trial-secret")');
    expect(source).not.toMatch(/x-trial-secret"\)\s*[!=]==/);
  });
});
