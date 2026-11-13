// Owner 2026-11-13: "Send the request to" lists the people who can really decide it, each with what they are:
// the owner, the managers of the person's site, and whoever holds leave approval with authority over them.
// Migration 20261113170000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

type Reviewer = { id: string; name: string; isOwner: boolean; role: string | null; managesMySite: boolean; isDeputy: boolean };
let t: TestDatabase;
let org: TestOrg;
let siteManager: TestMember;
let otherManager: TestMember;
let worker: TestMember;
let loner: TestMember;
let unassignedLead: TestMember;

const list = async (member: TestMember) => {
  const r = await t.as<{ r: Reviewer[] }>(member.authId, "select public.list_prosm_time_leave_reviewers() as r");
  if (r.error) throw new Error(r.error);
  return r.rows![0].r;
};

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Review Co");
  const site = await createSite(t, org, "Main");
  const other = await createSite(t, org, "Other", { latitude: 30.4, longitude: 31.4 });
  siteManager = await addMember(t, org, "manager", "Mona");
  otherManager = await addMember(t, org, "manager", "Omar");
  worker = await addMember(t, org, "employee", "Wael");
  loner = await addMember(t, org, "employee", "Lina");
  unassignedLead = await addMember(t, org, "manager", "Sami");
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, siteManager.userId]);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [other, otherManager.userId]);
  await assignToSite(t, site, worker);
  for (const key of ["leave.approve", "people.unassigned"]) {
    expect((await t.as(org.owner.authId, "select public.set_prosm_time_user_permission_override($1, $2, true, 'lead')", [unassignedLead.userId, key])).error).toBeNull();
  }
});

describe("who a leave request can go to", () => {
  it("someone at a site: the owner and that site's manager - not another site's", async () => {
    const r = await list(worker);
    expect(r.map((x) => x.name)).toEqual(expect.arrayContaining(["Mona"]));
    expect(r.find((x) => x.isOwner)).toBeTruthy();
    expect(r.find((x) => x.name === "Mona")).toMatchObject({ managesMySite: true, role: "manager" });
    expect(r.find((x) => x.name === "Omar")).toBeUndefined();
  });

  it("someone without a site: the owner and whoever looks after people without a site", async () => {
    const r = await list(loner);
    expect(r.find((x) => x.isOwner)).toBeTruthy();
    expect(r.find((x) => x.name === "Sami")).toMatchObject({ role: "manager", managesMySite: false });
    expect(r.find((x) => x.name === "Mona")).toBeUndefined();
  });

  it("anyone listed can really decide it", async () => {
    const sent = await t.as<{ r: { requestId?: string } }>(loner.authId,
      "select public.request_prosm_time_leave('annual', current_date + 20, current_date + 20, 'trip', null, $1) as r", [unassignedLead.userId]);
    expect(sent.error).toBeNull();
    const [req] = await t.su<{ id: string }>("select id from leave_requests where user_id = $1 order by created_at desc limit 1", [loner.userId]);
    const decided = await t.as(unassignedLead.authId, "select public.review_prosm_time_leave($1, 'approved')", [req.id]);
    expect(decided.error).toBeNull();
  });
});
