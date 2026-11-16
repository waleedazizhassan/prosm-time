// Department managers (owner 2026-11-16), migration 20261116180000: one manager per department, set by the owner or a
// departments.manage holder, only an active member of the same organisation, audited; listed for the people page.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let other: TestOrg;
let finance: string;
let rana: TestMember;
let worker: TestMember;
let stranger: TestMember;

const set = (who: TestMember, dept: string, user: string | null) => t.as(who.authId, "select public.set_prosm_time_department_manager($1, $2)", [dept, user]);
const list = async (who: TestMember) =>
  ((await t.as<{ r: { departmentName: string; userId: string }[] }>(who.authId, "select public.list_prosm_time_department_managers() as r")).rows?.[0].r ?? []);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Depts");
  other = await createOrg(t, "OtherDepts");
  rana = await addMember(t, org, "manager", "Rana");
  worker = await addMember(t, org, "employee", "Worker");
  stranger = await addMember(t, other, "employee", "Stranger");
  [{ id: finance }] = await t.su<{ id: string }>("insert into departments (organization_id, name) values ($1, 'Finance') returning id", [org.id]);
});

describe("a manager for each department", () => {
  it("the owner sets one; it is listed and audited", async () => {
    expect((await set(org.owner, finance, rana.userId)).error).toBeNull();
    expect(await list(worker)).toEqual([expect.objectContaining({ departmentName: "Finance", userId: rana.userId })]);
    expect((await t.su("select 1 from audit_logs where action = 'DEPARTMENT_MANAGER_SET' and entity_id = $1", [finance])).length).toBe(1);
  });

  it("someone without departments.manage cannot; a person of another organisation cannot be chosen", async () => {
    expect((await set(worker, finance, worker.userId)).error).toMatch(/NOT ALLOWED/);
    expect((await set(org.owner, finance, stranger.userId)).error).toMatch(/ACTIVE MEMBER/);
  });

  it("another organisation sees nothing of it; clearing removes them from the list", async () => {
    expect(await list(stranger)).toEqual([]);
    expect((await set(org.owner, finance, null)).error).toBeNull();
    expect(await list(worker)).toEqual([]);
  });
});
