// HR suite feature 1 (2026-11-11): the graded penalties bylaw and incentives - the bylaw cannot be
// switched on without the company's cap, appeal window and liability acknowledgement; the suggested list
// is a draft; lateness becomes a violation with the right occurrence and step; refused ones do not count
// and the count starts again after the look-back period; a newer bylaw never changes a recorded one; an
// approved permission removes it; investigation, reply and approval levels go in order; the deduction
// reaches payroll under the cap (the rest carried over) and an accepted appeal pays it back; incentives.
// Migration 20261111220000.
import { describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestOrg } from "./support/fixtures";

type Row = { id: string; status: string; occurrence: number; suggested: { code: string; value: number | null }; amount: string | null; actions: string[] };

async function rpc<T>(t: TestDatabase, authId: string, sql: string, params: unknown[] = []): Promise<T> {
  const r = await t.as<T>(authId, sql, params);
  if (r.error) throw new Error(r.error);
  return r.rows![0];
}

async function bylaw(t: TestDatabase, org: TestOrg) {
  const b = await rpc<{ b: { actionTypes: { id: string; code: string }[] } }>(t, org.owner.authId, "select public.get_prosm_time_penalty_bylaw() as b");
  const action = (code: string) => b.b.actionTypes.find((a) => a.code === code)!.id;
  return { action };
}

async function publishBackdated(t: TestDatabase, org: TestOrg) {
  await rpc(t, org.owner.authId, "select public.save_prosm_time_penalty_settings($1)",
    [JSON.stringify({ capUnit: "days_per_month", capDays: 2, appealWindowDays: 7, acknowledgeLiability: true })]);
  const today = (await t.su<{ d: string }>("select (now() at time zone 'Africa/Cairo')::date::text as d"))[0].d;
  const p = await rpc<{ r: { id: string; version: number } }>(t, org.owner.authId, "select public.publish_prosm_time_penalty_bylaw($1, false, null) as r", [today]);
  await t.su("alter table bylaw_versions disable trigger bylaw_versions_immutable");
  await t.su("update bylaw_versions set effective_from = '2026-01-01' where id = $1", [p.r.id]);
  await t.su("alter table bylaw_versions enable trigger bylaw_versions_immutable");
  return p.r;
}

const lateOn = (t: TestDatabase, org: TestOrg, userId: string, site: string, day: string) =>
  t.su("insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at, clock_out_at) values ($1, $2, $3, 'clocked_out', $4, $5)",
    [org.id, userId, site, `${day} 06:30:00+00`, `${day} 14:00:00+00`]); // 08:30 Cairo, 30 minutes late

const evaluate = (t: TestDatabase, userId: string, day: string) => t.su("select public.prosm_time_penalties_evaluate_day($1, $2)", [userId, day]);

const violations = async (t: TestDatabase, org: TestOrg, userId: string) =>
  (await rpc<{ v: Row[] }>(t, org.owner.authId, "select public.list_prosm_time_violations($1) as v", [userId])).v.reverse();

describe("penalties and incentives", () => {
  it("cannot be switched on without the company's own cap, appeal window and liability notice; the suggested list is a draft", async () => {
    const t = await buildDatabase();
    expect(t.failures).toEqual([]);
    const org = await createOrg(t, "Bylaw Co");
    await bylaw(t, org);
    // no legal value from PROSM: the cap and the appeal window start empty
    const [s] = await t.su<{ cap_unit: string | null; appeal_window_days: number | null }>("select cap_unit, appeal_window_days from penalty_settings where organization_id = $1", [org.id]);
    expect(s).toEqual({ cap_unit: null, appeal_window_days: null });
    const publish = () => t.as(org.owner.authId, "select public.publish_prosm_time_penalty_bylaw((now() at time zone 'Africa/Cairo')::date, false, null)");
    expect((await publish()).error).toMatch(/SET THE DEDUCTION CAP FIRST/);
    await rpc(t, org.owner.authId, "select public.save_prosm_time_penalty_settings($1)", [JSON.stringify({ capUnit: "percent_of_wage", capPercent: 10 })]);
    expect((await publish()).error).toMatch(/SET THE APPEAL WINDOW FIRST/);
    await rpc(t, org.owner.authId, "select public.save_prosm_time_penalty_settings($1)", [JSON.stringify({ capUnit: "percent_of_wage", capPercent: 10, appealWindowDays: 5 })]);
    expect((await publish()).error).toMatch(/ACKNOWLEDGE THE LIABILITY NOTICE FIRST/);
    await rpc(t, org.owner.authId, "select public.save_prosm_time_penalty_settings($1)",
      [JSON.stringify({ capUnit: "percent_of_wage", capPercent: 10, appealWindowDays: 5, acknowledgeLiability: true })]);
    const [ack] = await t.su<{ by: string | null }>("select liability_acknowledged_by::text as by from penalty_settings where organization_id = $1", [org.id]);
    expect(ack.by).toBe(org.owner.userId);

    const added = await rpc<{ r: { added: number } }>(t, org.owner.authId, "select public.add_prosm_time_penalty_template() as r");
    expect(added.r.added).toBeGreaterThan(0);
    const [drafts] = await t.su<{ on: number; off: number }>(
      "select count(*) filter (where is_active)::int as on, count(*) filter (where not is_active)::int as off from violation_types where organization_id = $1", [org.id]);
    expect(drafts).toEqual({ on: 0, off: added.r.added });
    expect((await publish()).error).toMatch(/TURN ON AT LEAST ONE VIOLATION/);
    const employee = await addMember(t, org, "employee", "Amira");
    expect((await t.as(employee.authId, "select public.get_prosm_time_penalty_bylaw()")).error).toMatch(/PERMISSION DENIED/);
  });

  it("lateness makes a violation with the right occurrence and step; refused ones do not count; the count starts again; a later bylaw changes nothing recorded; a permission removes it", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Late Co");
    const site = await createSite(t, org, "Main");
    await t.su("update sites set timezone = 'Africa/Cairo', shift_start_time = '08:00', late_deduction_start_time = '08:00' where id = $1", [site]);
    const amira = await addMember(t, org, "employee", "Amira");
    await assignToSite(t, site, amira);
    await t.su("update users set created_at = '2026-01-01' where id = $1", [amira.userId]);
    const { action } = await bylaw(t, org);
    const type = await rpc<{ r: { id: string } }>(t, org.owner.authId, "select public.save_prosm_time_violation_type(null, $1) as r", [JSON.stringify({
      name: "تأخير", source: "attendance_late", thresholdMinutes: 15, lookbackDays: 30, isActive: true,
      steps: [{ occurrence: 1, actionTypeId: action("written_warning") }, { occurrence: 2, actionTypeId: action("deduct_days"), value: 0.25 },
              { occurrence: 3, actionTypeId: action("deduct_days"), value: 0.5 }],
    })]);
    await publishBackdated(t, org);

    await lateOn(t, org, amira.userId, site, "2026-10-01");
    await evaluate(t, amira.userId, "2026-10-01");
    await evaluate(t, amira.userId, "2026-10-01"); // the same day again: never twice
    let list = await violations(t, org, amira.userId);
    expect(list.map((v) => [v.occurrence, v.suggested.code])).toEqual([[1, "written_warning"]]);

    await lateOn(t, org, amira.userId, site, "2026-10-04");
    await evaluate(t, amira.userId, "2026-10-04");
    list = await violations(t, org, amira.userId);
    expect(list[1]).toMatchObject({ occurrence: 2, suggested: { code: "deduct_days", value: 0.25 }, status: "pending_approval" });
    // refused (with a reason): it no longer counts
    expect((await t.as(org.owner.authId, "select public.act_prosm_time_violation($1, 'reject', '{}')", [list[1].id])).error).toMatch(/REASON IS REQUIRED/);
    await rpc(t, org.owner.authId, "select public.act_prosm_time_violation($1, 'reject', $2)", [list[1].id, JSON.stringify({ note: "Traffic accident" })]);
    await lateOn(t, org, amira.userId, site, "2026-10-05");
    await evaluate(t, amira.userId, "2026-10-05");
    list = await violations(t, org, amira.userId);
    expect(list[2]).toMatchObject({ occurrence: 2, suggested: { code: "deduct_days", value: 0.25 } });

    // a new bylaw version (now 1 day) does not change the one still waiting
    await rpc(t, org.owner.authId, "select public.save_prosm_time_violation_type($1, $2)", [type.r.id, JSON.stringify({
      name: "تأخير", source: "attendance_late", thresholdMinutes: 15, lookbackDays: 30,
      steps: [{ occurrence: 1, actionTypeId: action("deduct_days"), value: 1 }] })]);
    await rpc(t, org.owner.authId, "select public.publish_prosm_time_penalty_bylaw((now() at time zone 'Africa/Cairo')::date + 1, false, null)");
    const waiting = await rpc<{ v: { suggested: { value: number }; version: number } }>(t, org.owner.authId, "select public.get_prosm_time_violation($1) as v", [list[2].id]);
    expect(waiting.v).toMatchObject({ suggested: { value: 0.25 }, version: 1 });
    await expect(t.su("update bylaw_versions set snapshot = '{}' where organization_id = $1", [org.id])).rejects.toThrow(/CANNOT BE CHANGED/);

    // more than 30 days with no lateness: the count starts again
    await lateOn(t, org, amira.userId, site, "2026-11-09");
    await evaluate(t, amira.userId, "2026-11-09");
    list = await violations(t, org, amira.userId);
    expect(list[3]).toMatchObject({ occurrence: 1, suggested: { code: "written_warning" } });

    // an approved late-arrival permission for that day removes the violation (and makes no new one)
    await t.su("insert into attendance_permissions (organization_id, user_id, work_date, kind, paid, status, reason) values ($1, $2, '2026-11-09', 'late_arrival', true, 'approved', 'Doctor')",
      [org.id, amira.userId]);
    list = await violations(t, org, amira.userId);
    expect(list[3].status).toBe("cancelled");
    await evaluate(t, amira.userId, "2026-11-09");
    expect((await violations(t, org, amira.userId)).length).toBe(4);
    // every step is in the action log
    const [audit] = await t.su<{ n: number }>("select count(*)::int as n from audit_logs where organization_id = $1 and action like 'hr.violation_%'", [org.id]);
    expect(audit.n).toBeGreaterThanOrEqual(5);
  });

  it("investigation, reply and levels go in order; the deduction reaches payroll under the cap; an accepted appeal pays it back; incentives", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Steps Co");
    await t.su("update payroll_settings set statutory = '{}'::jsonb");
    const site = await createSite(t, org, "Main");
    const amira = await addMember(t, org, "employee", "Amira");
    const sami = await addMember(t, org, "manager", "Sami");
    await assignToSite(t, site, amira);
    await assignToSite(t, site, sami);
    await t.su("update site_assignments set role_at_site = 'manager' where user_id = $1", [sami.userId]);
    await t.su("update users set created_at = '2026-01-01' where id = $1", [amira.userId]);

    // a salary card: 9000 a month, 300 a day
    const component = (await rpc<{ r: { id: string } }>(t, org.owner.authId, "select public.save_prosm_time_payroll_component(null, $1) as r",
      [JSON.stringify({ name_ar: "الأساسي", name_en: "Basic", category: "earning", source: "fixed", is_basic: true })])).r.id;
    await rpc(t, org.owner.authId, "select public.save_prosm_time_payroll_profile($1, $2)", [amira.userId, JSON.stringify({ legal_name: "موظف تجريبي", currency: "EGP" })]);
    await rpc(t, org.owner.authId, "select public.set_prosm_time_payroll_profile_component($1, $2, 9000, null, '2026-01-01')", [amira.userId, component]);

    const { action } = await bylaw(t, org);
    await rpc(t, org.owner.authId, "select public.save_prosm_time_penalty_action_type($1, $2)", [action("deduct_days"), JSON.stringify({
      requiresInvestigation: true, requiresResponse: true, responseDays: 2, levels: ["manager", "hr"], reporterCannotApprove: true })]);
    const phone = await rpc<{ r: { id: string } }>(t, org.owner.authId, "select public.save_prosm_time_violation_type(null, $1) as r", [JSON.stringify({
      name: "Phone at the machine", source: "manual", isActive: true, steps: [{ occurrence: 1, actionTypeId: action("deduct_days"), value: 1 }] })]);
    await publishBackdated(t, org);
    // the cap: half a day a month (150)
    await rpc(t, org.owner.authId, "select public.save_prosm_time_penalty_settings($1)",
      [JSON.stringify({ capUnit: "days_per_month", capDays: 0.5, appealWindowDays: 7 })]);

    const act = (who: string, id: string, a: string, data: Record<string, unknown> = {}) =>
      t.as(who, "select public.act_prosm_time_violation($1, $2, $3)", [id, a, JSON.stringify(data)]);
    expect((await t.as(amira.authId, "select public.record_prosm_time_violation($1, $2, '2026-10-10', 'x', null)", [sami.userId, phone.r.id])).error).toMatch(/PERMISSION DENIED/);
    const rec = await rpc<{ r: { id: string } }>(t, sami.authId, "select public.record_prosm_time_violation($1, $2, '2026-10-10', 'Using the phone at the press', null) as r",
      [amira.userId, phone.r.id]);
    const id = rec.r.id;
    const status = async () => (await t.su<{ status: string; current_level: number }>("select status, current_level from employee_violations where id = $1", [id]))[0];
    expect(await status()).toMatchObject({ status: "pending_investigation" });
    expect((await act(sami.authId, id, "approve")).error).toMatch(/NOT AVAILABLE/);
    // the employee does not see it before they are told
    expect((await rpc<{ v: Row[] }>(t, amira.authId, "select public.list_prosm_time_violations($1) as v", [amira.userId])).v).toEqual([]);
    expect((await act(org.owner.authId, id, "investigate", {})).error).toMatch(/INVESTIGATION REPORT/);
    expect((await act(org.owner.authId, id, "investigate", { note: "Seen by two workers" })).error).toBeNull();
    expect(await status()).toMatchObject({ status: "pending_response" });
    expect((await act(org.owner.authId, id, "approve")).error).toMatch(/NOT AVAILABLE/); // the reply time is not over
    expect((await act(amira.authId, id, "respond", { note: "It was an urgent call from home" })).error).toBeNull();
    expect(await status()).toMatchObject({ status: "pending_approval", current_level: 0 });
    // the one who recorded it may not approve it
    expect((await act(sami.authId, id, "approve")).error).toMatch(/NOT AVAILABLE/);
    expect((await act(org.owner.authId, id, "approve")).error).toBeNull();
    expect(await status()).toMatchObject({ status: "pending_approval", current_level: 1 });
    expect((await act(org.owner.authId, id, "approve")).error).toBeNull();
    expect(await status()).toMatchObject({ status: "approved" });
    const [v] = await t.su<{ amount: string }>("select amount::text from employee_violations where id = $1", [id]);
    expect(Number(v.amount)).toBe(300);

    // October's cycle takes 150 (the cap); November's the other 150
    const lines = async (cycleId: string) => t.su<{ name_en: string; amount: string; category: string }>(
      "select l.name_en, l.amount::text, l.category from payroll_cycle_lines l join payroll_cycle_employees ce on ce.id = l.cycle_employee_id where ce.cycle_id = $1 and l.source in ('penalty', 'incentive') order by l.category",
      [cycleId]);
    const oct = await rpc<{ r: { cycleId: string } }>(t, org.owner.authId, "select public.create_prosm_time_payroll_cycle('2026-10-01', '2026-10-31', null, 'October') as r");
    expect((await lines(oct.r.cycleId)).map((l) => [l.category, Number(l.amount)])).toEqual([["deduction", 150]]);
    await t.su("update payroll_cycles set status = 'approved' where id = $1", [oct.r.cycleId]);
    const nov = await rpc<{ r: { cycleId: string } }>(t, org.owner.authId, "select public.create_prosm_time_payroll_cycle('2026-11-01', '2026-11-30', null, 'November') as r");
    expect((await lines(nov.r.cycleId)).map((l) => [l.category, Number(l.amount)])).toEqual([["deduction", 150]]);

    // the employee acknowledges, then appeals; the appeal is accepted: November drops it, October's 150 comes back
    expect((await act(amira.authId, id, "acknowledge")).error).toBeNull();
    expect((await act(amira.authId, id, "appeal", { note: "Please look again" })).error).toBeNull();
    expect(await status()).toMatchObject({ status: "appealed" });
    expect((await act(org.owner.authId, id, "appeal_cancel", { note: "Accepted" })).error).toBeNull();
    expect(await status()).toMatchObject({ status: "cancelled" });
    expect((await lines(nov.r.cycleId)).map((l) => [l.category, Number(l.amount)])).toEqual([["earning", 150]]);

    // an incentive: proposed by the manager, approved by personnel (the owner), paid as an earning
    const inc = await rpc<{ r: { id: string } }>(t, sami.authId, "select public.grant_prosm_time_incentive($1, $2) as r",
      [amira.userId, JSON.stringify({ amountType: "days", value: 1, reason: "Saved the night shift" })]);
    expect((await t.as(sami.authId, "select public.act_prosm_time_incentive($1, 'approve', null)", [inc.r.id])).error).toMatch(/NOT AVAILABLE/);
    expect((await t.as(org.owner.authId, "select public.act_prosm_time_incentive($1, 'approve', null)", [inc.r.id])).error).toBeNull();
    expect((await lines(nov.r.cycleId)).map((l) => [l.category, Number(l.amount)])).toEqual([["earning", 150], ["earning", 300]].sort());
    const [note] = await t.su<{ n: number }>("select count(*)::int as n from notifications where user_id = $1 and type = 'incentive_granted'", [amira.userId]);
    expect(note.n).toBe(1);
  });
});
