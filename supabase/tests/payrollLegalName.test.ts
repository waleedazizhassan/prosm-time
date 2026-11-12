// 2026-11-10 (owner): the salary card requires the person's official name, in Arabic when the payroll
// follows an Arab country's law (Egypt by default), and that name - not the user's display name - is the
// one on the payslip; the open cycles follow a changed name. Migration 20261110190000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, createOrg } from "./support/fixtures";

describe("payroll official name", () => {
  it("is required, Arabic in Egypt, and is the name on the payslip", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Name Co");
    await t.su("update payroll_settings set statutory = '{}'::jsonb");
    const nick = await addMember(t, org, "employee", "Mido");
    const save = (body: Record<string, unknown>) =>
      t.as(org.owner.authId, "select public.save_prosm_time_payroll_profile($1, $2)", [nick.userId, JSON.stringify(body)]);

    expect((await save({ currency: "EGP" })).error).toMatch(/LEGAL NAME IS REQUIRED/);
    expect((await save({ currency: "EGP", legal_name: "Mohamed Ali" })).error).toMatch(/LEGAL NAME MUST BE IN ARABIC/);
    expect((await save({ currency: "EGP", legal_name: "محمد Ali" })).error).toMatch(/LEGAL NAME MUST BE IN ARABIC/);
    expect((await save({ currency: "EGP", legal_name: "  محمد   علي  " })).error).toBeNull();
    const [profile] = await t.su<{ legal_name: string }>("select legal_name from payroll_profiles where user_id = $1", [nick.userId]);
    expect(profile.legal_name).toBe("محمد علي");

    // the cycle carries the official name, and an open cycle follows a change
    const basic = await t.as<{ r: { id: string } }>(org.owner.authId, "select public.save_prosm_time_payroll_component(null, $1) as r",
      [JSON.stringify({ name_ar: "الأساسي", name_en: "Basic", category: "earning", source: "fixed", is_basic: true })]);
    await t.as(org.owner.authId, "select public.set_prosm_time_payroll_profile_component($1, $2, 9000, null, '2027-06-01')", [nick.userId, basic.rows![0].r.id]);
    const created = await t.as<{ r: { cycleId: string } }>(org.owner.authId, "select public.create_prosm_time_payroll_cycle('2027-06-01', '2027-06-30', null, 'June') as r");
    expect(created.error).toBeNull();
    const nameInCycle = async () => (await t.su<{ full_name: string }>("select full_name from payroll_cycle_employees where cycle_id = $1 and user_id = $2",
      [created.rows![0].r.cycleId, nick.userId]))[0].full_name;
    expect(await nameInCycle()).toBe("محمد علي");
    expect((await save({ currency: "EGP", legal_name: "محمد علي حسن" })).error).toBeNull();
    expect(await nameInCycle()).toBe("محمد علي حسن");

    // another country's payroll takes the name as written
    await t.su("update payroll_settings set country_code = 'DE' where organization_id = $1", [org.id]);
    expect((await save({ currency: "EUR", legal_name: "Mohamed Ali Hassan" })).error).toBeNull();
  });
});
