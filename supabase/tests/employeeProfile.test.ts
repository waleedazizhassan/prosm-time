// HR suite feature 3 (2026-11-11): the full employee profile - who sees what, the personnel data, job
// titles, contracts and the history. Migration 20261111200000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite } from "./support/fixtures";

describe("employee profile", () => {
  it("gives the owner everything, a manager no sensitive data, the person a read-only view, others nothing", async () => {
    const t = await buildDatabase();
    expect(t.failures).toEqual([]);
    const org = await createOrg(t, "Profile Co");
    const site = await createSite(t, org, "Main");
    const amira = await addMember(t, org, "employee", "Amira");
    const omar = await addMember(t, org, "employee", "Omar");
    const mona = await addMember(t, org, "manager", "Mona");
    await assignToSite(t, site, amira);
    await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, mona.userId]);

    const title = await t.as<{ r: { id: string } }>(org.owner.authId, "select public.save_prosm_time_job_title(null, 'فني كهرباء') as r");
    expect(title.error).toBeNull();
    expect((await t.as(org.owner.authId, "select public.save_prosm_time_job_title(null, ' فني كهرباء ')")).error).toMatch(/ALREADY EXISTS/);
    const saved = await t.as(org.owner.authId, "select public.save_prosm_time_employee_hr_data($1, $2)", [amira.userId, JSON.stringify({
      national_id: "29001011234567", birth_date: "1990-01-01", phone: "01000000000", address: "Cairo",
      emergency_contact_name: "Ali", emergency_contact_phone: "01111111111", job_title_id: title.rows![0].r.id,
    })]);
    expect(saved.error).toBeNull();

    type P = { access: string; header: { jobTitle: string }; personal: { nationalId: string | null; phone: string | null }; contracts: unknown[] | null; canEdit: boolean };
    const read = async (authId: string) => t.as<{ p: P }>(authId, "select public.get_prosm_time_employee_profile($1) as p", [amira.userId]);

    const asOwner = (await read(org.owner.authId)).rows![0].p;
    expect(asOwner).toMatchObject({ access: "full", canEdit: true, header: { jobTitle: "فني كهرباء" }, personal: { nationalId: "29001011234567" } });
    const asManager = (await read(mona.authId)).rows![0].p;
    expect(asManager).toMatchObject({ access: "manager", canEdit: false, personal: { nationalId: null, phone: "01000000000" }, contracts: null });
    const asSelf = (await read(amira.authId)).rows![0].p;
    expect(asSelf).toMatchObject({ access: "self", canEdit: false, personal: { nationalId: "29001011234567" } });
    expect((await read(omar.authId)).error).toMatch(/PERMISSION DENIED/);

    // only full access changes the file
    expect((await t.as(mona.authId, "select public.save_prosm_time_employee_hr_data($1, $2)", [amira.userId, JSON.stringify({ phone: "x" })])).error).toMatch(/PERMISSION DENIED/);
    expect((await t.as(amira.authId, "select public.save_prosm_time_employee_hr_data($1, $2)", [amira.userId, JSON.stringify({ phone: "x" })])).error).toMatch(/PERMISSION DENIED/);

    // hr.manage, granted, gives full access
    await t.su(`insert into user_permission_overrides (user_id, permission_id, is_granted)
                select $1, id, true from permissions where permission_key = 'hr.manage'`, [omar.userId]);
    expect((await read(omar.authId)).rows![0].p.access).toBe("full");
  });

  it("keeps contracts with their checks, and shows the changes in the history", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Contract Co");
    const amira = await addMember(t, org, "employee", "Amira");
    const save = (data: Record<string, unknown>) =>
      t.as<{ r: { id: string } }>(org.owner.authId, "select public.save_prosm_time_employee_contract(null, $1, $2) as r", [amira.userId, JSON.stringify(data)]);
    expect((await save({ type: "fixed_term", start_date: "2026-01-01" })).error).toMatch(/NEEDS AN END DATE/);
    expect((await save({ type: "open_ended", start_date: "2026-03-01", end_date: "2026-01-01" })).error).toMatch(/BEFORE THE START/);
    expect((await save({ type: "open_ended", start_date: "2026-01-01", probation_end_date: "2026-04-01" })).error).toBeNull();
    const history = await t.as<{ h: { action: string }[] }>(org.owner.authId, "select public.list_prosm_time_employee_history($1) as h", [amira.userId]);
    expect(history.rows![0].h.map((r) => r.action)).toContain("hr.contract_saved");
    const activity = await t.as<{ a: { totals: { worked: number }; leave: unknown[] } }>(org.owner.authId, "select public.get_prosm_time_employee_activity($1, 14) as a", [amira.userId]);
    expect(activity.error).toBeNull();
    expect(activity.rows![0].a.totals.worked).toBe(0);
  });

  it("puts documents and penalties in Business and above", async () => {
    const t = await buildDatabase();
    const flags = await t.su<{ key: string; d: boolean; p: boolean }>(
      "select key, coalesce((feature_flags ->> 'documents')::boolean, false) as d, coalesce((feature_flags ->> 'penalties')::boolean, false) as p from plans order by key");
    const byKey = Object.fromEntries(flags.map((f) => [f.key, f]));
    expect(byKey.starter).toMatchObject({ d: false, p: false });
    for (const key of ["business", "pro", "enterprise", "legacy"]) expect(byKey[key]).toMatchObject({ d: true, p: true });
  });
});
