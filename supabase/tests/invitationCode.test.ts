// Security review M6, owner 2026-10-20: invitation codes are stored hashed,
// five wrong codes lock the invitation, and every failure looks the same.
// Migration 20261020200000.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { createOrg, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;

async function invite(name: string, code: string): Promise<string> {
  const authId = randomUUID();
  const email = `${name}-${authId.slice(0, 6)}@test.local`;
  await t.su("insert into auth.users (id, email) values ($1, $2)", [authId, email]);
  await t.su("select public.create_invited_prosm_time_user($1, $2, $3, 'employee', $4, $5, $6, now() + interval '7 days')", [
    org.id,
    authId,
    org.owner.userId,
    email,
    name,
    code,
  ]);
  return email;
}
const redeem = async (email: string, code: string) =>
  (await t.su<{ r: { success: boolean; error?: string } }>("select public.redeem_prosm_time_invitation($1, $2) as r", [email, code]))[0].r;

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
});

describe("invitation codes", () => {
  it("never stores the code in plain text", async () => {
    const email = await invite("Hana", "481516");
    const [row] = await t.su<{ verification_code: string }>(
      "select ui.verification_code from user_invitations ui join users u on u.id = ui.user_id where u.email = lower($1)",
      [email],
    );
    expect(row.verification_code).not.toBe("481516");
    expect((await redeem(email, "481516")).success).toBe(true);
  });

  it("locks the invitation after five wrong codes", async () => {
    const email = await invite("Omar", "112233");
    for (let attempt = 0; attempt < 5; attempt += 1) expect((await redeem(email, "000000")).success).toBe(false);
    expect(await redeem(email, "112233")).toEqual({ success: false, error: "INVALID VERIFICATION CODE" });
  });

  it("answers an unknown email exactly like a wrong code", async () => {
    expect(await redeem("nobody@test.local", "123456")).toEqual({ success: false, error: "INVALID VERIFICATION CODE" });
  });
});
