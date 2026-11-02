// 2026-11-02 (docs/IDEAS.md 5 and 6): open shifts and end-of-shift checklists.
// Migration 20261102190000.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite } from "./support/fixtures";

const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe("open shifts", () => {
  it("goes to the person the manager picks, as a scheduled shift", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Open Co");
    const site = await createSite(t, org, "Yard");
    const first = await addMember(t, org, "employee", "First");
    const second = await addMember(t, org, "employee", "Second");
    const outsider = await addMember(t, org, "employee", "Outsider");
    for (const member of [first, second]) await assignToSite(t, site, member);

    const created = await t.as<{ id: string }>(org.owner.authId, "select public.create_prosm_time_open_shift($1, $2, '08:00', '16:00') as id", [site, future(3)]);
    const shiftId = created.rows![0].id;
    expect((await t.as(first.authId, "select public.create_prosm_time_open_shift($1, $2, '08:00', '16:00')", [site, future(3)])).error).toMatch(/DO NOT MANAGE/);
    expect((await t.as(outsider.authId, "select public.request_prosm_time_open_shift($1)", [shiftId])).error).toMatch(/NOT AT THIS SITE/);
    for (const member of [first, second]) expect((await t.as(member.authId, "select public.request_prosm_time_open_shift($1)", [shiftId])).error).toBeNull();

    const [request] = await t.su<{ id: string }>("select id from open_shift_requests where user_id = $1", [second.userId]);
    expect((await t.as(org.owner.authId, "select public.decide_prosm_time_open_shift_request($1, true)", [request.id])).error).toBeNull();
    expect(await t.su("select id from shift_assignments where user_id = $1", [second.userId])).toHaveLength(1);
    const statuses = await t.su<{ status: string }>("select status from open_shift_requests order by status");
    expect(statuses.map((row) => row.status)).toEqual(["approved", "rejected"]);
    expect((await t.as(first.authId, "select * from public.list_prosm_time_open_shifts()")).rows).toHaveLength(0);
  });
});

describe("shift checklist", () => {
  it("keeps what was ticked with the shift, for the person and the manager", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "List Co");
    const site = await createSite(t, org, "Yard");
    const worker = await addMember(t, org, "employee", "Worker");
    const other = await addMember(t, org, "employee", "Other");
    await assignToSite(t, site, worker);
    expect((await t.as(org.owner.authId, "select public.set_prosm_time_site_checklist($1, array['Tools returned', 'Area clean'])", [site])).error).toBeNull();
    expect((await t.as(worker.authId, "select public.set_prosm_time_site_checklist($1, array['x'])", [site])).error).toMatch(/DO NOT MANAGE/);
    const items = (await t.as<{ id: string; label: string }>(worker.authId, "select * from public.list_prosm_time_site_checklist($1)", [site])).rows!;
    expect(items.map((item) => item.label)).toEqual(["Tools returned", "Area clean"]);

    const [session] = await t.su<{ id: string }>("insert into attendance_sessions (organization_id, user_id, site_id, status, clock_in_at) values ($1, $2, $3, 'clocked_in', now()) returning id", [org.id, worker.userId, site]);
    expect((await t.as(other.authId, "select public.record_prosm_time_session_checklist($1, $2::uuid[])", [session.id, [items[0].id]])).error).toMatch(/SHIFT NOT FOUND/);
    expect((await t.as(worker.authId, "select public.record_prosm_time_session_checklist($1, $2::uuid[])", [session.id, [items[0].id]])).error).toBeNull();
    const answers = (await t.as<{ label: string; done: boolean }>(org.owner.authId, "select * from public.list_prosm_time_session_checklist($1)", [session.id])).rows!;
    expect(answers).toEqual([{ label: "Tools returned", done: true }, { label: "Area clean", done: false }]);
  });
});
