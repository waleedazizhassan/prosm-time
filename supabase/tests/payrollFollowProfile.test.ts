// 2026-11-10 (owner): items added to a salary card after a cycle was created reach that cycle while
// it is open (draft / reopened); an approved or locked cycle keeps its copy. Migration 20261110130000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, createOrg } from "./support/fixtures";

describe("open payroll cycles follow the salary file", () => {
  it("adds a new earning and deduction to the open cycle, and leaves an approved one as it was", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Follow Co");
    await t.su("update payroll_settings set statutory = '{}'::jsonb");
    const amira = await addMember(t, org, "employee", "Amira");
    const rpc = async <T,>(sql: string, params: unknown[] = []) => {
      const r = await t.as<T>(org.owner.authId, sql, params);
      if (r.error) throw new Error(r.error);
      return r.rows![0];
    };
    const component = async (body: Record<string, unknown>) =>
      (await rpc<{ r: { id: string } }>("select public.save_prosm_time_payroll_component(null, $1) as r", [JSON.stringify(body)])).r.id;
    const basic = await component({ name_ar: "الأساسي", name_en: "Basic", category: "earning", source: "fixed", is_basic: true });
    await rpc("select public.save_prosm_time_payroll_profile($1, $2)", [amira.userId, JSON.stringify({ currency: "EGP" })]);
    await rpc("select public.set_prosm_time_payroll_profile_component($1, $2, 10000, null, '2027-03-01')", [amira.userId, basic]);

    const created = await rpc<{ r: { cycleId: string } }>("select public.create_prosm_time_payroll_cycle('2027-03-01', '2027-03-31', null, 'March') as r");
    const lines = async () =>
      (await t.su<{ name_en: string; amount: string; category: string }>(
        "select l.name_en, l.amount::text, l.category from payroll_cycle_lines l join payroll_cycle_employees ce on ce.id = l.cycle_employee_id where ce.cycle_id = $1 and ce.user_id = $2 order by l.name_en",
        [created.r.cycleId, amira.userId],
      ));
    expect((await lines()).map((l) => l.name_en)).toEqual(["Basic"]);

    // the owner adds an earning and a deduction from the salary card
    const love = await component({ name_ar: "بالحب", name_en: "Bonus", category: "earning", source: "fixed", calc_type: "amount", include_in_net: true });
    const fee = await component({ name_ar: "بدل غلاسة", name_en: "Fee", category: "deduction", source: "fixed", calc_type: "amount", include_in_net: true });
    await rpc("select public.set_prosm_time_payroll_profile_component($1, $2, 1000, null, '2027-03-01')", [amira.userId, love]);
    await rpc("select public.set_prosm_time_payroll_profile_component($1, $2, 250, null, '2027-03-01')", [amira.userId, fee]);

    const now = await lines();
    expect(now.map((l) => l.name_en)).toEqual(["Basic", "Bonus", "Fee"]);
    const [ce] = await t.su<{ net_salary: string }>("select net_salary::text from payroll_cycle_employees where cycle_id = $1 and user_id = $2", [created.r.cycleId, amira.userId]);
    expect(Number(ce.net_salary)).toBe(10000 + 1000 - 250);

    // an approved cycle keeps its copy
    await t.su("update payroll_cycles set status = 'approved' where id = $1", [created.r.cycleId]);
    await rpc("select public.set_prosm_time_payroll_profile_component($1, $2, 2000, null, '2027-03-01')", [amira.userId, love]);
    const after = await lines();
    expect(after.find((l) => l.name_en === "Bonus")?.amount).toBe("1000.00");
  });

  it("deletes an item from the cards and the open cycle, never the basic salary", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Delete Co");
    await t.su("update payroll_settings set statutory = '{}'::jsonb");
    const amira = await addMember(t, org, "employee", "Amira");
    const rpc = async <T,>(sql: string, params: unknown[] = []) => {
      const r = await t.as<T>(org.owner.authId, sql, params);
      if (r.error) throw new Error(r.error);
      return r.rows![0];
    };
    const component = async (body: Record<string, unknown>) =>
      (await rpc<{ r: { id: string } }>("select public.save_prosm_time_payroll_component(null, $1) as r", [JSON.stringify(body)])).r.id;
    const basic = await component({ name_ar: "الأساسي", name_en: "Basic", category: "earning", source: "fixed", is_basic: true });
    const fee = await component({ name_ar: "بدل غلاسة", name_en: "Fee", category: "deduction", source: "fixed", calc_type: "amount", include_in_net: true });
    await rpc("select public.save_prosm_time_payroll_profile($1, $2)", [amira.userId, JSON.stringify({ currency: "EGP" })]);
    await rpc("select public.set_prosm_time_payroll_profile_component($1, $2, 10000, null, '2027-04-01')", [amira.userId, basic]);
    await rpc("select public.set_prosm_time_payroll_profile_component($1, $2, 500, null, '2027-04-01')", [amira.userId, fee]);
    const created = await rpc<{ r: { cycleId: string } }>("select public.create_prosm_time_payroll_cycle('2027-04-01', '2027-04-30', null, 'April') as r");
    const names = async () => (await t.su<{ name_en: string }>(
      "select l.name_en from payroll_cycle_lines l join payroll_cycle_employees ce on ce.id = l.cycle_employee_id where ce.cycle_id = $1 order by 1", [created.r.cycleId])).map((r) => r.name_en);
    expect(await names()).toEqual(["Basic", "Fee"]);

    await rpc("select public.save_prosm_time_payroll_component($1, $2)", [fee, JSON.stringify({ is_active: false })]);
    expect(await names()).toEqual(["Basic"]);
    const list = await rpc<{ r: { id: string; is_active: boolean }[] }>("select public.list_prosm_time_payroll_components() as r");
    expect(list.r.find((c) => c.id === fee)?.is_active).toBe(false);

    const refused = await t.as(org.owner.authId, "select public.save_prosm_time_payroll_component($1, $2)", [basic, JSON.stringify({ is_active: false })]);
    expect(refused.error).toMatch(/BASIC SALARY CANNOT BE DELETED/);
  });

  // owner 2026-11-10: an item removed from one employee's card ends for that person only, and their open
  // cycle follows even when the value is deleted (it started on the date it is removed from)
  it("removes an item from one person's card and open cycle, and leaves the other person's", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "One Co");
    await t.su("update payroll_settings set statutory = '{}'::jsonb");
    const amira = await addMember(t, org, "employee", "Amira");
    const omar = await addMember(t, org, "employee", "Omar");
    const rpc = async <T,>(sql: string, params: unknown[] = []) => {
      const r = await t.as<T>(org.owner.authId, sql, params);
      if (r.error) throw new Error(r.error);
      return r.rows![0];
    };
    const component = async (body: Record<string, unknown>) =>
      (await rpc<{ r: { id: string } }>("select public.save_prosm_time_payroll_component(null, $1) as r", [JSON.stringify(body)])).r.id;
    const basic = await component({ name_ar: "الأساسي", name_en: "Basic", category: "earning", source: "fixed", is_basic: true });
    const bonus = await component({ name_ar: "حافز", name_en: "Bonus", category: "earning", source: "fixed", calc_type: "amount", include_in_net: true });
    for (const person of [amira, omar]) {
      await rpc("select public.save_prosm_time_payroll_profile($1, $2)", [person.userId, JSON.stringify({ currency: "EGP" })]);
      await rpc("select public.set_prosm_time_payroll_profile_component($1, $2, 10000, null, '2027-05-01')", [person.userId, basic]);
      await rpc("select public.set_prosm_time_payroll_profile_component($1, $2, 700, null, '2027-05-01')", [person.userId, bonus]);
    }
    const created = await rpc<{ r: { cycleId: string } }>("select public.create_prosm_time_payroll_cycle('2027-05-01', '2027-05-31', null, 'May') as r");
    const names = async (userId: string) => (await t.su<{ name_en: string }>(
      "select l.name_en from payroll_cycle_lines l join payroll_cycle_employees ce on ce.id = l.cycle_employee_id where ce.cycle_id = $1 and ce.user_id = $2 order by 1",
      [created.r.cycleId, userId])).map((r) => r.name_en);
    expect(await names(amira.userId)).toEqual(["Basic", "Bonus"]);

    // removed from Amira from the date it started on: her value is deleted and her open cycle follows
    await rpc("select public.set_prosm_time_payroll_profile_component($1, $2, null, null, '2027-05-01')", [amira.userId, bonus]);
    expect(await names(amira.userId)).toEqual(["Basic"]);
    expect(await names(omar.userId)).toEqual(["Basic", "Bonus"]);
  });
});
