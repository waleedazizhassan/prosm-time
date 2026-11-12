// Owner 2026-11-12: the full legal name given at the invitation - set by whoever has authority over the
// person or by personnel, shown in the file, and followed by the salary card. Migration 20261112100000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, createOrg } from "./support/fixtures";

describe("legal name at the invitation", () => {
  it("is set by the owner (not by a colleague), shown in the file and followed by the salary card", async () => {
    const t = await buildDatabase();
    expect(t.failures).toEqual([]);
    const org = await createOrg(t, "Names Co");
    const amira = await addMember(t, org, "employee", "Amira");
    const omar = await addMember(t, org, "employee", "Omar");
    expect((await t.as(omar.authId, "select public.set_prosm_time_user_legal_name($1, 'أميرة عادل محمد حسن')", [amira.userId])).error).toMatch(/PERMISSION DENIED/);
    expect((await t.as(org.owner.authId, "select public.set_prosm_time_user_legal_name($1, 'أ')", [amira.userId])).error).toMatch(/FULL LEGAL NAME/);
    expect((await t.as(org.owner.authId, "select public.set_prosm_time_user_legal_name($1, 'أميرة  عادل محمد حسن')", [amira.userId])).error).toBeNull();
    const file = await t.as<{ p: { header: { legalName: string; fullName: string } } }>(org.owner.authId, "select public.get_prosm_time_employee_profile($1) as p", [amira.userId]);
    expect(file.rows![0].p.header).toMatchObject({ legalName: "أميرة عادل محمد حسن", fullName: "Amira" });
    // a salary card made later takes it without being typed again
    const saved = await t.as(org.owner.authId, "select public.save_prosm_time_payroll_profile($1, $2)", [amira.userId, JSON.stringify({ currency: "EGP" })]);
    expect(saved.error).toBeNull();
    const [card] = await t.su<{ legal_name: string }>("select legal_name from payroll_profiles where user_id = $1", [amira.userId]);
    expect(card.legal_name).toBe("أميرة عادل محمد حسن");
  });
});
