// Owner 2026-10-20: an employee with no site stays with the Owner, or whoever
// the Owner authorises (people.unassigned). Migration 20261020160000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let manager: TestMember;
let walker: TestMember;

const requestLeave = async () => {
  const result = await t.as(walker.authId, "select public.request_prosm_time_leave('annual', current_date + 30, current_date + 31, 'Trip')");
  if (result.error) throw new Error(result.error);
  return (await t.su<{ id: string }>("select id from leave_requests where user_id = $1 order by created_at desc limit 1", [walker.userId]))[0].id;
};
const review = (id: string) => t.as(manager.authId, "select public.review_prosm_time_leave($1, 'approved', null)", [id]);

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Nile");
  const siteId = await createSite(t, org, "Site A");
  manager = await addMember(t, org, "manager", "Manager A");
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [siteId, manager.userId]);
  walker = await addMember(t, org, "employee", "Walker"); // no site
});

describe("employees not tied to a site", () => {
  it("are the Owner's until the Owner gives a manager people.unassigned", async () => {
    const first = await requestLeave();
    expect((await review(first)).error).toMatch(/YOU DO NOT MANAGE THIS EMPLOYEES SITE/);
    expect((await t.as(org.owner.authId, "select public.set_prosm_time_user_permission_override($1, 'people.unassigned', true, 'covers walk-ins')", [manager.userId])).error).toBeNull();
    expect((await review(first)).error).toBeNull();
  });
});
