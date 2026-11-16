// Owner 2026-11-16, migration 20261117180000: Connect - managers see everyone; employees their sites and department;
// nobody sees the owner; supervisors their sites, department and every manager; an existing conversation can be answered.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let mgrA: TestMember;
let mgrB: TestMember;
let supA: TestMember;
let empA: TestMember;
let empA2: TestMember;
let empB: TestMember;
let deptPeer: TestMember;

const people = async (who: TestMember) =>
  ((await t.as<{ p: { id: string }[] }>(who.authId, "select public.list_prosm_time_connect_people() as p")).rows![0].p ?? []).map((p) => p.id);
const open = (who: TestMember, other: TestMember) => t.as(who.authId, "select public.prosm_time_connect_open_direct($1)", [other.userId]);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Vis");
  await t.su("insert into entitlements (organization_id, plan, status) values ($1, 'enterprise', 'active') on conflict (organization_id) do update set plan = 'enterprise', status = 'active'", [org.id]);
  const a = await createSite(t, org, "A");
  const b = await createSite(t, org, "B");
  mgrA = await addMember(t, org, "manager", "MgrA");
  mgrB = await addMember(t, org, "manager", "MgrB");
  supA = await addMember(t, org, "supervisor", "SupA");
  empA = await addMember(t, org, "employee", "EmpA");
  empA2 = await addMember(t, org, "employee", "EmpA2");
  empB = await addMember(t, org, "employee", "EmpB");
  deptPeer = await addMember(t, org, "employee", "DeptPeer");
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager'), ($3, $4, 'manager')", [a, mgrA.userId, b, mgrB.userId]);
  for (const m of [supA, empA, empA2]) await assignToSite(t, a, m);
  await assignToSite(t, b, empB);
  const [{ id: dept }] = await t.su<{ id: string }>("insert into departments (organization_id, name) values ($1, 'Stores') returning id", [org.id]);
  await t.su("update users set department_id = $1 where id = any($2::uuid[])", [dept, [empA.userId, deptPeer.userId]]);
});

describe("who sees whom", () => {
  it("nobody sees the owner; the owner sees everyone", async () => {
    for (const who of [mgrA, supA, empA]) expect(await people(who)).not.toContain(org.owner.userId);
    const all = await people(org.owner);
    for (const m of [mgrA, mgrB, supA, empA, empB, deptPeer]) expect(all).toContain(m.userId);
  });
  it("a manager sees everyone at every site", async () => {
    const seen = await people(mgrA);
    for (const m of [mgrB, empB, deptPeer, empA]) expect(seen).toContain(m.userId);
  });
  it("an employee sees their site and their department only", async () => {
    const seen = await people(empA);
    for (const m of [empA2, supA, mgrA, deptPeer]) expect(seen).toContain(m.userId);
    for (const m of [empB, mgrB]) expect(seen).not.toContain(m.userId);
  });
  it("a supervisor sees their site and every manager", async () => {
    const seen = await people(supA);
    for (const m of [empA, mgrA, mgrB]) expect(seen).toContain(m.userId);
    expect(seen).not.toContain(empB.userId);
  });
});

describe("who may contact whom", () => {
  it("an employee cannot open a chat or call someone outside their reach; a manager can", async () => {
    expect((await open(empA, empB)).error).toMatch(/CANNOT CONTACT/);
    expect((await t.as(empA.authId, "select public.prosm_time_connect_start_call($1, 'audio')", [empB.userId])).error).toMatch(/CANNOT CONTACT/);
    expect((await open(mgrB, empA)).error).toBeNull();
  });
  it("an existing conversation can be answered (the owner or a manager from elsewhere wrote first)", async () => {
    expect((await open(org.owner, empB)).error).toBeNull();
    expect((await open(empB, org.owner)).error).toBeNull();
    expect((await open(empA, mgrB)).error).toBeNull(); // mgrB opened it above
  });
  it("a group and a meeting take only people the creator sees", async () => {
    expect((await t.as(empA.authId, "select public.prosm_time_connect_create_group('x', $1)", [[empA2.userId, empB.userId]])).error).toMatch(/CANNOT CONTACT/);
    expect((await t.as(empA.authId, "select public.prosm_time_connect_create_group('x', $1)", [[empA2.userId]])).error).toBeNull();
  });
});
