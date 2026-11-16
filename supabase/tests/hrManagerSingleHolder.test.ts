// Owner 2026-11-16, migration 20261117110000: the HR manager authority MOVES - giving personnel files (hr.manage) to
// a second person takes the HR set from the first; their role's own permissions and other sets' keys stay.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let first: TestMember;
let second: TestMember;

const grant = (who: TestMember, key: string) =>
  t.as(org.owner.authId, "select public.set_prosm_time_user_permission_override($1, $2, true, 'hr test')", [who.userId, key]);
const granted = async (who: TestMember) =>
  (await t.su<{ k: string }>("select p.permission_key as k from user_permission_overrides o join permissions p on p.id = o.permission_id where o.user_id = $1 and o.is_granted order by 1", [who.userId])).map((r) => r.k);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "HrMove");
  first = await addMember(t, org, "manager", "First");
  second = await addMember(t, org, "manager", "Second");
});

describe("one HR manager at a time", () => {
  it("giving hr.manage to a second person moves the HR set, keeps shared keys, and audits it", async () => {
    for (const key of ["hr.manage", "employees.create", "leave.manage_types", "reports.view", "payroll.view"]) expect((await grant(first, key)).error).toBeNull();
    expect((await t.as(org.owner.authId, "select public.list_prosm_time_hr_manager_holders($1) as h", [second.userId])).rows![0]).toMatchObject({ h: [{ id: first.userId }] });

    expect((await grant(second, "hr.manage")).error).toBeNull();
    expect(await granted(first)).toEqual(["payroll.view", "reports.view"]);
    expect(await granted(second)).toContain("hr.manage");
    const audit = await t.su("select 1 from audit_logs where action = 'HR_MANAGER_MOVED' and subject_user_id = $1", [first.userId]);
    expect(audit).toHaveLength(1);
    expect((await t.as(org.owner.authId, "select public.list_prosm_time_hr_manager_holders(null) as h")).rows![0]).toMatchObject({ h: [{ id: second.userId }] });
  });

  it("other permissions never move anything, and an employee cannot list holders", async () => {
    expect((await grant(first, "leave.approve")).error).toBeNull();
    expect(await granted(second)).toContain("hr.manage");
    const employee = await addMember(t, org, "employee", "Plain");
    expect((await t.as(employee.authId, "select public.list_prosm_time_hr_manager_holders(null)")).error).toMatch(/PERMISSIONS.ASSIGN/);
  });
});
