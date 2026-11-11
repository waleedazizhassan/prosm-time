// HR suite feature 4 (2026-11-11): tax and insurance configuration - the values shown are the engine's
// own; the calculator and the payroll call the same function; a custom configuration needs the liability
// acknowledgement once; wrong input is refused clearly; versions apply from their month and never change
// earlier cycles; a cycle with custom rules says so; the country cannot change with an open cycle.
// Migration 20261111230000.
import { describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, type TestOrg } from "./support/fixtures";

async function rpc<T>(t: TestDatabase, authId: string, sql: string, params: unknown[] = []): Promise<T> {
  const r = await t.as<T>(authId, sql, params);
  if (r.error) throw new Error(r.error);
  return r.rows![0];
}

const jordanLike = {
  schema: 2,
  bases: [{ code: "basic", kind: "basic" }, { code: "gross", kind: "gross" }, { code: "taxable", kind: "taxable" }, { code: "insurable", kind: "insurable" }],
  incomeTax: { enabled: true, baseCode: "taxable", period: "annual_div_12", reliefs: [{ kind: "fixed", value: 9000 }],
               brackets: [{ upTo: 5000, rate: 5 }, { upTo: 10000, rate: 10 }, { upTo: null, rate: 20 }], tiers: [] },
  insurance: { enabled: true, defaultCategory: "citizen", categories: [
    { code: "citizen", name: "Citizen", branches: [{ code: "social", baseCode: "basic", rules: [{ payer: "employee", rate: 7.5, maxBase: 4000 }, { payer: "employer", rate: 14.25, maxBase: 4000 }] }] },
    { code: "foreign", name: "Foreign", branches: [{ code: "social", baseCode: "basic", rules: [{ payer: "employee", rate: 0 }, { payer: "employer", rate: 2 }] }] }] },
  levies: [],
};
const n = (v: unknown) => Number(v);

async function payrollPerson(t: TestDatabase, org: TestOrg, basic: number) {
  const m = await addMember(t, org, "employee", "Amira");
  const comp = (await rpc<{ r: { id: string } }>(t, org.owner.authId, "select public.save_prosm_time_payroll_component(null, $1) as r",
    [JSON.stringify({ name_ar: "الأساسي", name_en: "Basic", category: "earning", source: "fixed", is_basic: true })])).r.id;
  await rpc(t, org.owner.authId, "select public.save_prosm_time_payroll_profile($1, $2)", [m.userId, JSON.stringify({ legal_name: "موظف تجريبي", currency: "EGP" })]);
  await rpc(t, org.owner.authId, "select public.set_prosm_time_payroll_profile_component($1, $2, $3, null, '2026-01-01')", [m.userId, comp, basic]);
  return m;
}

describe("tax and insurance configuration", () => {
  it("shows Egypt from the engine's own source, and the calculator gives the payroll's result", async () => {
    const t = await buildDatabase();
    expect(t.failures).toEqual([]);
    const org = await createOrg(t, "Tax Co");
    const cfg = await rpc<{ c: { country: string; mode: string; matchesOfficial: boolean; rules: unknown; official: unknown } }>(t, org.owner.authId, "select public.get_prosm_time_tax_config() as c");
    expect(cfg.c).toMatchObject({ country: "EG", mode: "preset", matchesOfficial: true });
    // what the page shows = what the engine reads (the EG pack, written as the general document)
    const [engine] = await t.su<{ r: unknown }>("select public.prosm_time_statutory_v2(config) as r from payroll_country_packs where code = 'EG'");
    expect(cfg.c.rules).toEqual(engine.r);
    expect(cfg.c.official).toEqual(engine.r);

    const amira = await payrollPerson(t, org, 12000);
    const cycle = await rpc<{ r: { cycleId: string } }>(t, org.owner.authId, "select public.create_prosm_time_payroll_cycle('2026-10-01', '2026-10-31', null, 'Oct') as r");
    const lines = await t.su<{ rule: string; amount: string }>(
      "select l.source_ref ->> 'rule' as rule, l.amount::text from payroll_cycle_lines l join payroll_cycle_employees e on e.id = l.cycle_employee_id where e.cycle_id = $1 and e.user_id = $2 and l.source = 'statutory' order by 1",
      [cycle.r.cycleId, amira.userId]);
    const preview = await rpc<{ p: { lines: { rule: string; amount: number }[] } }>(t, org.owner.authId, "select public.preview_prosm_time_tax_config('{\"preset\":\"EG\"}', '{\"basic\":12000}') as p");
    expect(preview.p.lines.map((l) => [l.rule, n(l.amount)]).sort()).toEqual(lines.map((l) => [l.rule, n(l.amount)]).sort());
  });

  it("a custom configuration: refused when wrong, needs the liability notice once, starts from its month, and its cycles say so", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Custom Co");
    const amira = await payrollPerson(t, org, 3000);
    const today = (await t.su<{ m: string }>("select to_char(date_trunc('month', now() at time zone 'Africa/Cairo') + interval '1 month', 'YYYY-MM-DD') as m"))[0].m;
    const save = (body: Record<string, unknown>) => t.as(org.owner.authId, "select public.save_prosm_time_tax_config($1)", [JSON.stringify(body)]);
    // wrong input
    const overlapping = { ...jordanLike, incomeTax: { ...jordanLike.incomeTax, brackets: [{ upTo: 5000, rate: 5 }, { upTo: 4000, rate: 10 }, { upTo: null, rate: 20 }] } };
    expect((await save({ mode: "custom", rules: overlapping, effectiveFrom: today, acknowledgeLiability: true })).error).toMatch(/RISE IN ORDER/);
    const over100 = { ...jordanLike, incomeTax: { ...jordanLike.incomeTax, brackets: [{ upTo: null, rate: 120 }] } };
    expect((await save({ mode: "custom", rules: over100, effectiveFrom: today, acknowledgeLiability: true })).error).toMatch(/BETWEEN 0 AND 100/);
    const minAboveMax = { ...jordanLike, insurance: { ...jordanLike.insurance, categories: [{ code: "citizen", name: "C", branches: [{ code: "s", baseCode: "basic", rules: [{ payer: "employee", rate: 5, minBase: 500, maxBase: 100 }] }] }] } };
    expect((await save({ mode: "custom", rules: minAboveMax, effectiveFrom: today, acknowledgeLiability: true })).error).toMatch(/MAXIMUM INSURABLE WAGE/);
    // the liability notice, once, on the server
    expect((await save({ mode: "custom", rules: jordanLike, effectiveFrom: today })).error).toMatch(/ACKNOWLEDGE THE LIABILITY/);
    expect((await save({ mode: "custom", rules: jordanLike, effectiveFrom: today, acknowledgeLiability: true })).error).toBeNull();
    const [ack] = await t.su<{ by: string }>("select tax_liability_acknowledged_by::text as by from payroll_settings where organization_id = $1", [org.id]);
    expect(ack.by).toBe(org.owner.userId);
    expect((await save({ mode: "custom", rules: jordanLike, effectiveFrom: today })).error).toBeNull(); // later saves need no new acknowledgement
    // a version never changes
    await expect(t.su("update payroll_tax_configs set currency = 'USD' where organization_id = $1", [org.id])).rejects.toThrow(/CANNOT BE CHANGED/);

    // a cycle before the new month keeps Egypt; one from that month uses the custom rules and says so
    const before = await rpc<{ r: { cycleId: string } }>(t, org.owner.authId, "select public.create_prosm_time_payroll_cycle('2026-10-01', '2026-10-31', null, 'Oct') as r");
    const [b] = await t.su<{ mode: string }>("select policy_snapshot #>> '{statutoryMeta,mode}' as mode from payroll_cycles where id = $1", [before.r.cycleId]);
    expect(b.mode).toBe("preset");
    const end = (await t.su<{ e: string }>("select to_char(($1::date + interval '1 month' - interval '1 day'), 'YYYY-MM-DD') as e", [today]))[0].e;
    const after = await rpc<{ r: { cycleId: string } }>(t, org.owner.authId, "select public.create_prosm_time_payroll_cycle($1, $2, null, 'Next') as r", [today, end]);
    const [a] = await t.su<{ mode: string }>("select policy_snapshot #>> '{statutoryMeta,mode}' as mode from payroll_cycles where id = $1", [after.r.cycleId]);
    expect(a.mode).toBe("custom");
    // the payroll and the calculator agree for the same person (3,000: citizen insurance 7.5% capped at 4,000; tax on 3,000 x 12 - 9,000 = 27,000: 250 + 500 + 3,400 = 4,150 a year)
    const lines = await t.su<{ rule: string; amount: string }>(
      "select l.source_ref ->> 'rule' as rule, l.amount::text from payroll_cycle_lines l join payroll_cycle_employees e on e.id = l.cycle_employee_id where e.cycle_id = $1 and e.user_id = $2 and l.source = 'statutory' order by 1",
      [after.r.cycleId, amira.userId]);
    const preview = await rpc<{ p: { lines: { rule: string; amount: number }[] } }>(t, org.owner.authId, "select public.preview_prosm_time_tax_config($1, '{\"basic\":3000}') as p", [JSON.stringify(jordanLike)]);
    expect(preview.p.lines.map((l) => [l.rule, n(l.amount)]).sort()).toEqual(lines.map((l) => [l.rule, n(l.amount)]).sort());
    expect(Object.fromEntries(lines.map((l) => [l.rule, n(l.amount)]))).toEqual({ insurance_employee: 225, insurance_employer: 427.5, income_tax: 345.83 });
    // a foreign worker's category: no employee share
    await rpc(t, org.owner.authId, "select public.save_prosm_time_payroll_profile($1, $2)", [amira.userId, JSON.stringify({ insurance_category: "foreign" })]);
    const foreign = await rpc<{ p: { lines: { rule: string; amount: number }[] } }>(t, org.owner.authId, "select public.preview_prosm_time_tax_config($1, '{\"basic\":3000,\"category\":\"foreign\"}') as p", [JSON.stringify(jordanLike)]);
    expect(foreign.p.lines.find((l) => l.rule === "insurance_employee")?.amount).toBe(0);
    // a new version cannot start before the last cycle
    expect((await save({ mode: "preset", effectiveFrom: today })).error).toMatch(/ONLY AFTER THE LAST PAYROLL CYCLE/);
  });

  it("changes the country only for the owner, never with a cycle open, and from the first month with no cycle", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Move Co");
    const hr = await addMember(t, org, "manager", "Hana");
    await payrollPerson(t, org, 5000);
    const cycle = await rpc<{ r: { cycleId: string } }>(t, org.owner.authId, "select public.create_prosm_time_payroll_cycle('2026-10-01', '2026-10-31', null, 'Oct') as r");
    const change = (who: string, confirm: string) => t.as(who, "select public.change_prosm_time_payroll_country('JO', $1, 'JOD', true)", [confirm]);
    expect((await change(hr.authId, "JO")).error).toMatch(/ONLY THE OWNER/);
    expect((await change(org.owner.authId, "JO")).error).toMatch(/OPEN PAYROLL CYCLE/);
    await t.su("update payroll_cycles set status = 'locked' where id = $1", [cycle.r.cycleId]);
    expect((await change(org.owner.authId, "EG")).error).toMatch(/TYPE THE COUNTRY CODE/);
    const ok = await rpc<{ r: { effectiveFrom: string } }>(t, org.owner.authId, "select public.change_prosm_time_payroll_country('JO', 'jo', 'JOD', true) as r");
    expect(ok.r.effectiveFrom >= "2026-11-01").toBe(true);
    // the locked cycle keeps Egypt
    const [old] = await t.su<{ c: string }>("select policy_snapshot ->> 'country_code' as c from payroll_cycles where id = $1", [cycle.r.cycleId]);
    expect(old.c).toBe("EG");
    const cfg = await rpc<{ c: { country: string; mode: string } }>(t, org.owner.authId, "select public.get_prosm_time_tax_config() as c");
    expect(cfg.c).toMatchObject({ country: "JO", mode: "custom" });
    const [audit] = await t.su<{ n: number }>("select count(*)::int as n from audit_logs where organization_id = $1 and action = 'PAYROLL_COUNTRY_CHANGED'", [org.id]);
    expect(audit.n).toBe(1);
  });
});
