// HR suite feature 2 (2026-11-11): employee documents - the list per person, upload / review / archive,
// reminders without repeats, the overview, the completeness bar and the clock-in rule.
// Migration 20261111210000.
import { describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

async function setup(t: TestDatabase, name: string) {
  const org = await createOrg(t, name);
  const site = await createSite(t, org, "Main");
  const type = async (body: Record<string, unknown>) => {
    const r = await t.as<{ r: { id: string } }>(org.owner.authId, "select public.save_prosm_time_document_type(null, $1) as r", [JSON.stringify(body)]);
    if (r.error) throw new Error(r.error);
    return r.rows![0].r.id;
  };
  return { org, site, type };
}
const docs = async (t: TestDatabase, org: TestOrg, m: TestMember) =>
  (await t.as<{ d: { id: string; typeName: string; status: string; rejectionReason?: string | null; pendingId: string | null; pending: { id: string; expiryDate: string | null } | null; archived: unknown[] }[] }>(org.owner.authId,
    "select public.list_prosm_time_employee_documents($1) as d", [m.userId])).rows![0].d;
const file = (org: TestOrg, m: TestMember) => `${org.id}/${m.userId}/x.pdf`;

describe("employee documents", () => {
  it("gives a new person the documents that apply to them, by job title too", async () => {
    const t = await buildDatabase();
    expect(t.failures).toEqual([]);
    const { org, type } = await setup(t, "Docs Co");
    const driver = (await t.as<{ r: { id: string } }>(org.owner.authId, "select public.save_prosm_time_job_title(null, 'سائق') as r")).rows![0].r.id;
    await type({ name: "الشهادة الصحية", is_mandatory: true, has_expiry: true });
    await type({ name: "رخصة القيادة", is_mandatory: true, applies_to: "job_titles", job_title_ids: [driver] });
    const amira = await addMember(t, org, "employee", "Amira");
    expect((await docs(t, org, amira)).map((d) => [d.typeName, d.status])).toEqual([["الشهادة الصحية", "missing"]]);
    await t.as(org.owner.authId, "select public.save_prosm_time_employee_hr_data($1, $2)", [amira.userId, JSON.stringify({ job_title_id: driver })]);
    expect((await docs(t, org, amira)).map((d) => d.typeName).sort()).toEqual(["الشهادة الصحية", "رخصة القيادة"].sort());
    // the person and the personnel managers heard about the missing documents
    const notes = await t.su<{ n: number }>("select count(*)::int as n from notifications where type = 'document_missing'");
    expect(notes[0].n).toBeGreaterThanOrEqual(2);
  });

  it("an upload waits for review, an accepted renewal archives the old version, a rejection needs a reason", async () => {
    const t = await buildDatabase();
    const { org, type } = await setup(t, "Review Co");
    const health = await type({ name: "Health", is_mandatory: true, has_expiry: true });
    const amira = await addMember(t, org, "employee", "Amira");
    const submit = (by: TestMember | TestOrg["owner"], expiry: string, ref?: string) =>
      t.as<{ r: { id: string; replay?: boolean } }>(by.authId, "select public.submit_prosm_time_document($1, $2, $3) as r",
        [amira.userId, health, JSON.stringify({ file_path: file(org, amira), expiry_date: expiry, document_number: "HC-1", client_ref: ref })]);
    expect((await t.as(amira.authId, "select public.submit_prosm_time_document($1, $2, $3)", [amira.userId, health, JSON.stringify({ file_path: file(org, amira) })])).error).toMatch(/EXPIRY DATE IS REQUIRED/);
    const ref = "11111111-1111-4111-8111-111111111111";
    const first = await submit(amira, "2030-01-01", ref);
    expect(first.error).toBeNull();
    // the offline queue resends: never twice
    expect((await submit(amira, "2030-01-01", ref)).rows![0].r.replay).toBe(true);
    let list = await docs(t, org, amira);
    expect(list[0]).toMatchObject({ status: "missing", pendingId: first.rows![0].r.id });
    expect(list[0].pending).toMatchObject({ id: first.rows![0].r.id, expiryDate: "2030-01-01" });
    expect((await t.as(amira.authId, "select public.review_prosm_time_document($1, true, null)", [first.rows![0].r.id])).error).toMatch(/PERMISSION DENIED/);
    expect((await t.as(org.owner.authId, "select public.review_prosm_time_document($1, false, '')", [first.rows![0].r.id])).error).toMatch(/REASON IS REQUIRED/);
    expect((await t.as(org.owner.authId, "select public.review_prosm_time_document($1, true, null)", [first.rows![0].r.id])).error).toBeNull();
    list = await docs(t, org, amira);
    expect(list[0].status).toBe("valid");
    // a renewal by the personnel manager is accepted at once; the old version is archived
    expect((await submit(org.owner, "2032-01-01")).error).toBeNull();
    list = await docs(t, org, amira);
    expect(list[0].archived).toHaveLength(1);
    // the completeness bar
    const p = await t.as<{ p: { completion: { percent: number } } }>(org.owner.authId, "select public.get_prosm_time_employee_profile($1) as p", [amira.userId]);
    expect(p.rows![0].p.completion.percent).toBe(100);
    // a refused renewal shows its reason in her list (demo run 2026-11-12), the document in force stays valid
    const renewal = await submit(amira, "2034-01-01");
    expect((await t.as(org.owner.authId, "select public.review_prosm_time_document($1, false, 'الصورة غير واضحة')", [renewal.rows![0].r.id])).error).toBeNull();
    list = await docs(t, org, amira);
    expect(list[0]).toMatchObject({ status: "valid", rejectionReason: "الصورة غير واضحة" });
    // somebody else cannot upload into Amira's file
    const omar = await addMember(t, org, "employee", "Omar");
    expect((await t.as(omar.authId, "select public.submit_prosm_time_document($1, $2, $3)", [amira.userId, health, JSON.stringify({ file_path: file(org, amira), expiry_date: "2030-01-01" })])).error).toMatch(/PERMISSION DENIED/);
  });

  it("the daily job changes states and reminds once per day; the overview counts the same", async () => {
    const t = await buildDatabase();
    const { org, type } = await setup(t, "Remind Co");
    const health = await type({ name: "Health", is_mandatory: true, has_expiry: true, reminder_days: [30, 7, 0] });
    const amira = await addMember(t, org, "employee", "Amira");
    await t.as(org.owner.authId, "select public.submit_prosm_time_document($1, $2, $3)", [amira.userId, health, JSON.stringify({ file_path: file(org, amira), expiry_date: "2030-01-01" })]);
    // make it due in 7 days in the company's time, and run the job at 08:00 there
    await t.su("update employee_documents set expiry_date = ((now() at time zone public.prosm_time_site_timezone(null, organization_id))::date + 7) where user_id = $1 and is_current", [amira.userId]);
    const tz = (await t.su<{ tz: string }>("select public.prosm_time_site_timezone(null, $1) as tz", [org.id]))[0].tz;
    const hour = (await t.su<{ h: number }>("select extract(hour from (now() at time zone $1))::int as h", [tz]))[0].h;
    if (hour === 8) {
      await t.su("select public.process_prosm_time_document_reminders()");
      await t.su("select public.process_prosm_time_document_reminders()");
      const [{ n }] = await t.su<{ n: number }>("select count(*)::int as n from notifications where type = 'document_expiring' and user_id = $1", [amira.userId]);
      expect(n).toBe(1);
    }
    // whatever the hour: the state function and the overview
    expect((await t.su<{ s: string }>("select public.prosm_time_document_state(current_date + 7, array[30,7,0], current_date) as s"))[0].s).toBe("expiring");
    expect((await t.su<{ s: string }>("select public.prosm_time_document_state(current_date - 1, array[30,7,0], current_date) as s"))[0].s).toBe("expired");
    await t.su("update employee_documents set status = 'expired' where user_id = $1 and is_current", [amira.userId]);
    const o = (await t.as<{ o: { expired: number; action: { status: string }[] } }>(org.owner.authId, "select public.get_prosm_time_documents_overview() as o")).rows![0].o;
    expect(o.expired).toBe(1);
    expect(o.action.filter((a) => a.status === "expired")).toHaveLength(1);
  });

  it("an expired document set to block stops a self clock-in", async () => {
    const t = await buildDatabase();
    const { org, site, type } = await setup(t, "Block Co");
    const licence = await type({ name: "Guard licence", is_mandatory: true, has_expiry: true, clock_in_rule: "block" });
    const amira = await addMember(t, org, "employee", "Amira");
    await assignToSite(t, site, amira);
    await t.as(org.owner.authId, "select public.submit_prosm_time_document($1, $2, $3)", [amira.userId, licence, JSON.stringify({ file_path: file(org, amira), expiry_date: "2030-01-01" })]);
    await t.su("update employee_documents set status = 'expired' where user_id = $1 and is_current", [amira.userId]);
    expect((await clockIn(t, amira, site)).error).toMatch(/DOCUMENT REQUIRED TO CLOCK IN/);
    await t.su("update document_types set clock_in_rule = 'warn' where id = $1", [licence]);
    expect((await clockIn(t, amira, site)).error).toBeNull();
    const [{ n }] = await t.su<{ n: number }>("select count(*)::int as n from notifications where type = 'document_clock_in'");
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it("templates are names only, added as drafts", async () => {
    const t = await buildDatabase();
    const { org } = await setup(t, "Template Co");
    const r = await t.as<{ r: { added: number } }>(org.owner.authId, "select public.add_prosm_time_document_templates('eg') as r");
    expect(r.rows![0].r.added).toBe(7);
    const [{ active }] = await t.su<{ active: number }>("select count(*) filter (where is_active)::int as active from document_types where organization_id = $1", [org.id]);
    expect(active).toBe(0);
  });
});

// Owner 2026-11-12: personnel add any document from the person's file by its name
describe("a document added from the person's file", () => {
  it("reuses the kind by name or makes one that applies to nobody else; the person cannot", async () => {
    const t = await buildDatabase();
    expect(t.failures).toEqual([]);
    const { org } = await setup(t, "File Docs Co");
    const amira = await addMember(t, org, "employee", "Amira");
    const omar = await addMember(t, org, "employee", "Omar");
    const ensure = (by: TestMember, user: TestMember, name: string, expiry = true) =>
      t.as<{ r: { id: string; hasExpiry: boolean } }>(by.authId, "select public.ensure_prosm_time_person_document_type($1, $2, $3) as r", [user.userId, name, expiry]);
    expect((await ensure(amira, amira, "Driving licence")).error).toMatch(/PERMISSION DENIED/);
    expect((await ensure(org.owner, amira, "  ")).error).toMatch(/NAME IS REQUIRED/);
    const made = await ensure(org.owner, amira, "Driving  licence");
    expect(made.error).toBeNull();
    const again = await ensure(org.owner, omar, "driving licence", false);
    expect(again.rows![0].r.id).toBe(made.rows![0].r.id); // same kind, its own expiry rule kept
    expect(again.rows![0].r.hasExpiry).toBe(true);
    // added with its dates: accepted at once (personnel), valid, with its start and end
    const sent = await t.as(org.owner.authId, "select public.submit_prosm_time_document($1, $2, $3)",
      [amira.userId, made.rows![0].r.id, JSON.stringify({ file_path: file(org, amira), issue_date: "2026-01-01", expiry_date: "2031-01-01" })]);
    expect(sent.error).toBeNull();
    expect((await docs(t, org, amira)).map((d) => [d.typeName, d.status])).toEqual([["Driving licence", "valid"]]);
    expect(await docs(t, org, omar)).toEqual([]); // nobody else gets it
  });
});
