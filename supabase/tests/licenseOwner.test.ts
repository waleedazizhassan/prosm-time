// Owner 2026-11-12: the owner's data travels with the licence; a newer change from PROSM Platform reaches the
// owner's account (an older or repeated one changes nothing). Migration 20261112220000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, createOrg } from "./support/fixtures";

describe("licence owner", () => {
  it("applies a newer owner change once, and refuses another member's email", async () => {
    const t = await buildDatabase();
    expect(t.failures).toEqual([]);
    const org = await createOrg(t, "Owner Co");
    const amira = await addMember(t, org, "employee", "Amira");
    const apply = (owner: Record<string, unknown>) => t.su<{ r: { changed: boolean; emailChanged?: boolean } }>(
      "select public.apply_prosm_time_license_owner($1, $2) as r", [org.id, JSON.stringify(owner)]);
    const [identity] = await t.su<{ r: { ownerVersion: number; email: string } }>("select public.get_prosm_time_owner_identity($1) as r", [org.id]);
    expect(identity.r.ownerVersion).toBe(0);

    const [first] = await apply({ version: 1, legalName: "وليد عزيز حسن", nationalId: "29001010101010", phone: "01000000000" });
    expect(first.r).toMatchObject({ changed: true, emailChanged: false });
    const [u] = await t.su<{ legal_name: string; national_id: string; phone: string }>("select legal_name, national_id, phone from users where id = $1", [org.owner.userId]);
    expect(u).toMatchObject({ legal_name: "وليد عزيز حسن", national_id: "29001010101010", phone: "01000000000" });

    expect((await apply({ version: 1, fullName: "Someone else" }))[0].r.changed).toBe(false); // not newer
    await expect(apply({ version: 2, email: amira.email })).rejects.toThrow(/ANOTHER PERSON/);
    const [moved] = await apply({ version: 2, email: "New.Owner@test.local", fullName: "New Owner" });
    expect(moved.r).toMatchObject({ changed: true, emailChanged: true });
    const [after] = await t.su<{ email: string; full_name: string }>("select email, full_name from users where id = $1", [org.owner.userId]);
    expect(after).toMatchObject({ email: "new.owner@test.local", full_name: "New Owner" });
  });
});
