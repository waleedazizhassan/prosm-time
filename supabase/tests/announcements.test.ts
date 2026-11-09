// 2026-11-09 Media Center (migration 20261109230000): departments and announcements.
// Who may address whom; the recipients are fixed at publishing; everyone addressed is notified,
// nobody else sees anything; read and confirmation are tracked and seen within one's authority;
// scheduling and expiry run by the clock; email is queued only when chosen and is retried; files
// are opened only by recipients; another organisation sees nothing.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let other: TestOrg;
let siteA: string;
let siteB: string;
let managerA: TestMember;
let workerA: TestMember;
let workerB: TestMember;
let accountant: TestMember;
let outsider: TestMember;
let deptFinance = "";

async function ok<T>(result: Promise<{ rows: T[] | null; error: string | null }>): Promise<T> {
  const { rows, error } = await result;
  if (error) throw new Error(error);
  return rows![0];
}
const owner = (sql: string, params: unknown[] = []) => t.as(org.owner.authId, sql, params);
type Mine = { r: { unread: number; items: { id: string; title: string; viewedAt: string | null; acknowledgedAt: string | null; attachments: { id: string; kind: string }[] }[] } };
const mine = async (m: TestMember) => (await ok<Mine>(t.as(m.authId, "select public.list_my_prosm_time_announcements() as r"))).r;
const save = (as: string, data: Record<string, unknown>, id: string | null = null) => t.as<{ r: { id: string } }>(as, "select public.save_prosm_time_announcement($1, $2) as r", [id, JSON.stringify(data)]);
const publish = (as: string, id: string, at: string | null = null) => t.as<{ r: { status: string; recipients?: number } }>(as, "select public.publish_prosm_time_announcement($1, $2) as r", [id, at]);

beforeAll(async () => {
  t = await buildDatabase();
  expect(t.failures).toEqual([]);
  org = await createOrg(t, "News Co");
  other = await createOrg(t, "Other Co");
  siteA = await createSite(t, org, "A");
  siteB = await createSite(t, org, "B");
  managerA = await addMember(t, org, "manager", "Manager A");
  workerA = await addMember(t, org, "employee", "Worker A");
  workerB = await addMember(t, org, "employee", "Worker B");
  accountant = await addMember(t, org, "employee", "Accountant");
  outsider = await addMember(t, other, "employee", "Outsider");
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [siteA, managerA.userId]);
  await assignToSite(t, siteA, workerA);
  await assignToSite(t, siteB, workerB);
});

describe("departments", () => {
  it("the owner adds them; a person's department is set by whoever may edit them", async () => {
    deptFinance = (await ok<{ r: { id: string } }>(owner("select public.save_prosm_time_department(null, 'Finance') as r"))).r.id;
    expect((await owner("select public.save_prosm_time_department(null, ' finance ')")).error).toMatch(/ALREADY EXISTS/);
    expect((await t.as(workerA.authId, "select public.save_prosm_time_department(null, 'Sales')")).error).toMatch(/NOT ALLOWED/);
    await ok(owner("select public.set_prosm_time_user_department($1, $2)", [accountant.userId, deptFinance]));
    const d = await ok<{ r: { name: string } }>(owner("select public.get_prosm_time_user_department($1) as r", [accountant.userId]));
    expect(d.r.name).toBe("Finance");
    // another organisation's department cannot be used
    const otherDept = (await ok<{ r: { id: string } }>(t.as(other.owner.authId, "select public.save_prosm_time_department(null, 'Ops') as r"))).r.id;
    expect((await owner("select public.set_prosm_time_user_department($1, $2)", [accountant.userId, otherDept])).error).toMatch(/DEPARTMENT NOT FOUND/);
    const list = await ok<{ r: { name: string }[] }>(t.as(other.owner.authId, "select public.list_prosm_time_departments() as r"));
    expect(list.r.map((x) => x.name)).toEqual(["Ops"]);
  });
});

describe("who may address whom", () => {
  it("a manager publishes to the sites they manage and their people only; an employee not at all", async () => {
    expect((await save(workerA.authId, { title: "Hi", audienceType: "sites", audienceIds: [siteA] })).error).toMatch(/NOT ALLOWED/);
    expect((await save(managerA.authId, { title: "All", audienceType: "all" })).error).toMatch(/ORGANISATION-WIDE/);
    expect((await save(managerA.authId, { title: "Dept", audienceType: "departments", audienceIds: [deptFinance] })).error).toMatch(/ORGANISATION-WIDE/);
    expect((await save(managerA.authId, { title: "B", audienceType: "sites", audienceIds: [siteB] })).error).toMatch(/SITES YOU MANAGE/);
    expect((await save(managerA.authId, { title: "P", audienceType: "people", audienceIds: [workerB.userId] })).error).toMatch(/PEOPLE AT THE SITES/);
    expect((await save(managerA.authId, { title: "X", audienceType: "people", audienceIds: [outsider.userId] })).error).toMatch(/EMPLOYEE NOT FOUND/);
    expect((await save(managerA.authId, { title: "Site A notice", audienceType: "sites", audienceIds: [siteA] })).error).toBeNull();
  });
});

describe("publishing and reading", () => {
  let siteNotice = "";
  let deptNotice = "";

  it("a site announcement reaches the site's people only, notified, with nothing for anyone else", async () => {
    siteNotice = (await ok<{ r: { id: string } }>(save(managerA.authId, { title: "Gate closed Friday", body: "Use gate 2.", audienceType: "sites", audienceIds: [siteA], requiresAck: true }))).r.id;
    expect((await mine(workerA)).items).toHaveLength(0); // a draft reaches nobody
    const r = await ok<{ r: { status: string; recipients: number } }>(publish(managerA.authId, siteNotice));
    expect(r.r).toMatchObject({ status: "published", recipients: 2 }); // worker A and the manager
    const a = await mine(workerA);
    expect(a.items.map((x) => x.title)).toEqual(["Gate closed Friday"]);
    expect(a.unread).toBe(1);
    expect((await mine(workerB)).items).toHaveLength(0);
    expect((await mine(outsider)).items).toHaveLength(0);
    const notes = await t.su("select user_id from notifications where type = 'announcement_published' and related_entity_id = $1", [siteNotice]);
    expect(notes.map((n) => n.user_id)).toEqual([workerA.userId]); // not the publisher
  });

  it("opening and confirming are tracked; the bell is read too", async () => {
    await ok(t.as(workerA.authId, "select public.mark_prosm_time_announcement_read($1, false)", [siteNotice]));
    expect((await mine(workerA)).unread).toBe(1); // confirmation still required
    await ok(t.as(workerA.authId, "select public.mark_prosm_time_announcement_read($1, true)", [siteNotice]));
    const a = await mine(workerA);
    expect(a.unread).toBe(0);
    expect(a.items[0].acknowledgedAt).not.toBeNull();
    expect(await t.su("select 1 from notifications where user_id = $1 and related_entity_id = $2 and read_at is null", [workerA.userId, siteNotice])).toHaveLength(0);
    expect((await t.as(workerB.authId, "select public.mark_prosm_time_announcement_read($1, true)", [siteNotice])).error).toMatch(/NOT FOUND/);
  });

  it("who read: the owner sees everyone, a manager their own people, an employee nobody", async () => {
    const reads = await ok<{ r: { name: string; acknowledgedAt: string | null }[] }>(owner("select public.get_prosm_time_announcement_reads($1) as r", [siteNotice]));
    expect(reads.r.map((x) => x.name).sort()).toEqual(["Manager A", "Worker A"]);
    expect((await t.as(workerA.authId, "select public.get_prosm_time_announcement_reads($1)", [siteNotice])).error).toMatch(/NOT ALLOWED/);
    expect((await t.as(other.owner.authId, "select public.get_prosm_time_announcement_reads($1)", [siteNotice])).error).toMatch(/NOT FOUND/);
  });

  it("a department announcement with email reaches the department and queues one email each", async () => {
    deptNotice = (await ok<{ r: { id: string } }>(save(org.owner.authId, { title: "Closing the books", kind: "statement", audienceType: "departments", audienceIds: [deptFinance], sendEmail: true }))).r.id;
    await ok(publish(org.owner.authId, deptNotice));
    expect((await mine(accountant)).items.map((x) => x.title)).toEqual(["Closing the books"]);
    expect((await mine(workerA)).items.map((x) => x.title)).not.toContain("Closing the books");
    const [{ n }] = await t.su<{ n: number }>("select count(*)::int as n from announcement_recipients where announcement_id = $1 and email_status = 'pending'", [deptNotice]);
    expect(n).toBe(1);
    // without email nothing is queued
    const [{ none }] = await t.su<{ none: number }>("select count(*)::int as none from announcement_recipients where announcement_id = $1 and email_status = 'pending'", [siteNotice]);
    expect(none).toBe(0);
  });

  it("emails are claimed once, retried, and given up after three attempts", async () => {
    const claim = async () => (await t.su<{ r: { userId: string; title: string }[] }>("select public.prosm_time_announcement_email_claim(50) as r"))[0].r;
    const first = await claim();
    expect(first).toHaveLength(1);
    expect(first[0].title).toBe("Closing the books");
    expect(await claim()).toHaveLength(0); // claimed, not handed out twice
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await t.su("select public.prosm_time_announcement_email_result($1, $2, false, 'smtp down')", [deptNotice, accountant.userId]);
      await t.su("update announcement_recipients set email_next_at = now() - interval '1 second' where announcement_id = $1", [deptNotice]);
      if (attempt < 3) expect(await claim()).toHaveLength(1);
    }
    const [{ email_status }] = await t.su<{ email_status: string }>("select email_status from announcement_recipients where announcement_id = $1", [deptNotice]);
    expect(email_status).toBe("failed");
  });

  it("a published announcement cannot be edited; withdrawing needs a reason and hides it", async () => {
    expect((await save(managerA.authId, { title: "Changed", audienceType: "sites", audienceIds: [siteA] }, siteNotice)).error).toMatch(/CANNOT BE EDITED/);
    expect((await t.as(managerA.authId, "select public.withdraw_prosm_time_announcement($1, '')", [siteNotice])).error).toMatch(/REASON/);
    await ok(t.as(managerA.authId, "select public.withdraw_prosm_time_announcement($1, 'wrong date')", [siteNotice]));
    expect((await mine(workerA)).items).toHaveLength(0);
  });
});

describe("schedule and expiry", () => {
  it("a scheduled announcement appears at its time and disappears at its expiry", async () => {
    const id = (await ok<{ r: { id: string } }>(save(org.owner.authId, { title: "Holiday", audienceType: "all", expiresAt: new Date(Date.now() + 3 * 3600_000).toISOString() }))).r.id;
    const r = await ok<{ r: { status: string } }>(publish(org.owner.authId, id, new Date(Date.now() + 3600_000).toISOString()));
    expect(r.r.status).toBe("scheduled");
    await t.su("select public.prosm_time_announcements_tick()");
    expect((await mine(workerB)).items.map((x) => x.title)).not.toContain("Holiday");
    await t.su("update announcements set publish_at = now() - interval '1 second' where id = $1", [id]);
    await t.su("select public.prosm_time_announcements_tick()");
    expect((await mine(workerB)).items.map((x) => x.title)).toContain("Holiday");
    expect((await mine(outsider)).items).toHaveLength(0);
    await t.su("update announcements set expires_at = now() - interval '1 second' where id = $1", [id]);
    await t.su("select public.prosm_time_announcements_tick()");
    expect((await mine(workerB)).items.map((x) => x.title)).not.toContain("Holiday");
    const [{ status }] = await t.su<{ status: string }>("select status from announcements where id = $1", [id]);
    expect(status).toBe("expired");
  });

  it("an expiry before the publishing time is refused", async () => {
    const id = (await ok<{ r: { id: string } }>(save(org.owner.authId, { title: "Soon", audienceType: "all", expiresAt: new Date(Date.now() + 3600_000).toISOString() }))).r.id;
    expect((await publish(org.owner.authId, id, new Date(Date.now() + 2 * 3600_000).toISOString())).error).toMatch(/EXPIRY/);
  });
});

describe("links and files", () => {
  it("links need a full web address; files open for recipients only", async () => {
    const id = (await ok<{ r: { id: string } }>(save(org.owner.authId, { title: "Policy", audienceType: "people", audienceIds: [workerA.userId] }))).r.id;
    expect((await owner("select public.add_prosm_time_announcement_link($1, 'javascript:alert(1)', 'x')", [id])).error).toMatch(/FULL WEB ADDRESS/);
    await ok(owner("select public.add_prosm_time_announcement_link($1, 'https://youtu.be/abc', 'Video')", [id]));
    // the edge function records a stored file (service role only)
    expect((await owner("select public.prosm_time_announcement_attach_file($1, $2, gen_random_uuid(), 'p.pdf', 'application/pdf', 10, null)", [id, org.owner.userId])).error).not.toBeNull();
    const [{ r }] = await t.su<{ r: { id: string } }>("select public.prosm_time_announcement_attach_file($1, $2, gen_random_uuid(), 'policy.pdf', 'application/pdf', 1000, 'Policy') as r", [id, org.owner.userId]);
    // a worker who is not (yet) a recipient cannot open it; after publishing, the recipient can
    expect((await t.as(workerA.authId, "select public.prosm_time_announcement_file_for_reader($1)", [r.id])).error).toMatch(/NOT FOUND/);
    await ok(publish(org.owner.authId, id));
    const f = await ok<{ r: { assetId: string; fileName: string } }>(t.as(workerA.authId, "select public.prosm_time_announcement_file_for_reader($1) as r", [r.id]));
    expect(f.r.fileName).toBe("policy.pdf");
    expect((await t.as(workerB.authId, "select public.prosm_time_announcement_file_for_reader($1)", [r.id])).error).toMatch(/NOT FOUND/);
    expect((await t.as(outsider.authId, "select public.prosm_time_announcement_file_for_reader($1)", [r.id])).error).toMatch(/NOT FOUND/);
    expect((await mine(workerA)).items.find((x) => x.id === id)!.attachments.map((x) => x.kind).sort()).toEqual(["file", "link"]);
  });

  it("a draft with files is not deleted until its files are removed", async () => {
    const id = (await ok<{ r: { id: string } }>(save(org.owner.authId, { title: "Draft", audienceType: "all" }))).r.id;
    const [{ r }] = await t.su<{ r: { id: string } }>("select public.prosm_time_announcement_attach_file($1, $2, gen_random_uuid(), 'a.png', 'image/png', 5, null) as r", [id, org.owner.userId]);
    expect((await owner("select public.delete_prosm_time_announcement($1)", [id])).error).toMatch(/REMOVE THE FILES/);
    const removed = await ok<{ r: { kind: string; assetId: string } }>(owner("select public.remove_prosm_time_announcement_attachment($1) as r", [r.id]));
    expect(removed.r.kind).toBe("file");
    expect(removed.r.assetId).toBeTruthy();
    await ok(owner("select public.delete_prosm_time_announcement($1)", [id]));
  });
});

describe("isolation", () => {
  it("no client reads the tables directly, and another organisation's owner gets nothing", async () => {
    for (const table of ["announcements", "announcement_recipients", "announcement_attachments", "departments"]) {
      const r = await t.as(org.owner.authId, `select count(*) from ${table}`);
      expect(r.error, table).not.toBeNull();
    }
    const list = await ok<{ r: unknown[] }>(t.as(other.owner.authId, "select public.list_prosm_time_announcements_admin() as r"));
    expect(list.r).toEqual([]);
  });
});
