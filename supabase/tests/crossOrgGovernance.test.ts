// Release gate (owner 2026-11-16: "no mixing between organisations or departments"): the governance features added
// 2026-11-16 never reach across organisations, and a department manager decides only their own department.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let a: TestOrg;
let b: TestOrg;
let hrA: TestMember;
let deptBossA: TestMember;
let inDeptA: TestMember;
let otherDeptA: TestMember;
let workerB: TestMember;
let leaveB: string;
let leaveOtherDept: string;

const grant = (who: TestMember, key: string) =>
  t.su("insert into user_permission_overrides (user_id, permission_id, is_granted) select $1, id, true from permissions where permission_key = $2 on conflict do nothing", [who.userId, key]);
const leave = async (org: TestOrg, who: TestMember, n: number) =>
  (await t.su<{ id: string }>("insert into leave_requests (organization_id, user_id, leave_type, start_date, end_date, days_count, status) values ($1, $2, 'annual', date '2027-03-01' + $3::int * 7, date '2027-03-01' + $3::int * 7, 1, 'pending') returning id", [org.id, who.userId, n]))[0].id;

beforeAll(async () => {
  t = await buildDatabase();
  a = await createOrg(t, "OrgA");
  b = await createOrg(t, "OrgB");
  hrA = await addMember(t, a, "employee", "HrA");
  await grant(hrA, "hr.approve_all_requests");
  deptBossA = await addMember(t, a, "manager", "DeptBossA");
  await grant(deptBossA, "leave.approve");
  inDeptA = await addMember(t, a, "employee", "InDept");
  otherDeptA = await addMember(t, a, "employee", "OtherDept");
  workerB = await addMember(t, b, "employee", "WorkerB");
  const [{ id: d1 }] = await t.su<{ id: string }>("insert into departments (organization_id, name, manager_user_id) values ($1, 'Finance', $2) returning id", [a.id, deptBossA.userId]);
  const [{ id: d2 }] = await t.su<{ id: string }>("insert into departments (organization_id, name) values ($1, 'Sales') returning id", [a.id]);
  await t.su("update users set department_id = $1 where id = $2", [d1, inDeptA.userId]);
  await t.su("update users set department_id = $1 where id = $2", [d2, otherDeptA.userId]);
  leaveB = await leave(b, workerB, 1);
  leaveOtherDept = await leave(a, otherDeptA, 2);
});

describe("no mixing between organisations", () => {
  it("HR of one organisation cannot see or decide another organisation's requests", async () => {
    const queue = (await t.as<{ id: string }>(hrA.authId, "select id from public.list_prosm_time_pending_leave_requests()")).rows ?? [];
    expect(queue.map((r) => r.id)).not.toContain(leaveB);
    expect((await t.as(hrA.authId, "select public.review_prosm_time_leave($1, 'approved', 'x', null)", [leaveB])).error).not.toBeNull();
    const [{ status }] = await t.su<{ status: string }>("select status from leave_requests where id = $1", [leaveB]);
    expect(status).toBe("pending");
  });

  it("an organisation's governance model and its managers lists stay its own", async () => {
    expect((await t.as(a.owner.authId, "select public.set_prosm_time_governance_model('centralized')")).error).toBeNull();
    const [{ m }] = await t.su<{ m: string }>("select public.prosm_time_approval_mode($1, 'leave') as m", [b.id]);
    expect(m).toBe("direct");
    const holders = (await t.as<{ h: { id: string }[] }>(b.owner.authId, "select public.list_prosm_time_management_holders('hr', null) as h")).rows![0].h ?? [];
    expect(holders.map((h) => h.id)).not.toContain(hrA.userId);
    const overview = (await t.as<{ o: { hrApprovers: number } }>(b.owner.authId, "select public.get_prosm_time_governance_overview() as o")).rows![0].o;
    expect(overview.hrApprovers).toBe(0);
    await t.as(a.owner.authId, "select public.set_prosm_time_governance_model('direct')");
  });

  it("a department manager cannot be someone from another organisation", async () => {
    const [{ id: dept }] = await t.su<{ id: string }>("select id from departments where organization_id = $1 and name = 'Finance'", [a.id]);
    expect((await t.as(a.owner.authId, "select public.set_prosm_time_department_manager($1, $2)", [dept, workerB.userId])).error).toMatch(/ACTIVE MEMBER/);
  });
});

describe("no mixing between departments", () => {
  it("a department manager decides their own department only", async () => {
    const own = await leave(a, inDeptA, 3);
    const queue = ((await t.as<{ id: string }>(deptBossA.authId, "select id from public.list_prosm_time_pending_leave_requests()")).rows ?? []).map((r) => r.id);
    expect(queue).toContain(own);
    expect(queue).not.toContain(leaveOtherDept);
    expect((await t.as(deptBossA.authId, "select public.review_prosm_time_leave($1, 'approved', 'x', null)", [leaveOtherDept])).error).not.toBeNull();
    expect((await t.as(deptBossA.authId, "select public.review_prosm_time_leave($1, 'approved', 'x', null)", [own])).error).toBeNull();
  });
});
