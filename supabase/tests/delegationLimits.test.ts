// Owner 2026-11-08: delegation with limits (migration 20261108100000) - a window, full or
// partial scope, the actions that are never delegated, and no deciding one's own request.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let site: string;
let deputy: TestMember;
let helper: TestMember;
let worker: TestMember;
let siteless: TestMember;

const grant = (args: string, params: unknown[]) => t.as(org.owner.authId, `select public.grant_prosm_time_owner_authority(${args})`, params);
const revoke = (member: TestMember) => t.as(org.owner.authId, "select public.revoke_prosm_time_owner_authority($1, 'done')", [member.userId]);
const permissions = async (member: TestMember) =>
  (await t.as<{ p: string[] }>(member.authId, "select public.get_prosm_time_effective_permissions() as p")).rows![0].p ?? [];
const hasInternal = async (member: TestMember, key: string) =>
  (await t.su<{ ok: boolean }>("select public.prosm_time_user_has_permission_internal($1, $2) as ok", [member.userId, key]))[0].ok;

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Limits Co");
  site = await createSite(t, org, "Plant");
  deputy = await addMember(t, org, "supervisor", "Deputy");
  helper = await addMember(t, org, "supervisor", "Helper");
  worker = await addMember(t, org, "employee", "Worker");
  siteless = await addMember(t, org, "manager", "Siteless Manager");
  for (const member of [deputy, helper, worker]) await assignToSite(t, site, member);
});

describe("delegation window", () => {
  it("does nothing before it starts", async () => {
    expect((await grant("$1, 'next week', now() + interval '2 days', now() + interval '9 days'", [deputy.userId])).error).toBeNull();
    expect(await hasInternal(deputy, "audit.view")).toBe(false);
    expect((await permissions(deputy)).includes("audit.view")).toBe(false);
  });

  it("ends by itself", async () => {
    await t.su("update owner_delegations set starts_at = now() - interval '3 days', ends_at = now() + interval '1 hour' where user_id = $1", [deputy.userId]);
    expect(await hasInternal(deputy, "audit.view")).toBe(true);
    await t.su("update owner_delegations set ends_at = now() - interval '1 minute' where user_id = $1", [deputy.userId]);
    expect(await hasInternal(deputy, "audit.view")).toBe(false);
    // a new grant closes the ended one automatically
    expect((await grant("$1, 'again'", [deputy.userId])).error).toBeNull();
    expect(await hasInternal(deputy, "audit.view")).toBe(true);
  });

  it("refuses an end in the past or before the start", async () => {
    expect((await grant("$1, 'x', now(), now() - interval '1 day'", [helper.userId])).error).toMatch(/END MUST BE/);
  });
});

describe("partial delegation", () => {
  it("gives only the chosen permissions, and never the governance ones", async () => {
    expect((await grant("$1, 'cover leave', null, null, 'partial', array['permissions.assign']", [helper.userId])).error).toMatch(/NEVER DELEGATED/);
    expect((await grant("$1, 'cover leave', null, null, 'partial', array['leave.approve', 'audit.view']", [helper.userId])).error).toBeNull();
    const list = await permissions(helper);
    expect(list).toEqual(expect.arrayContaining(["leave.approve", "audit.view"]));
    expect(list.includes("settings.manage")).toBe(false);
    expect(await hasInternal(helper, "leave.approve")).toBe(true);
    // not the owner's own actions
    expect((await t.as(helper.authId, "select public.set_prosm_time_overtime_alert_minutes(20)")).error).toMatch(/ONLY THE OWNER/);
    expect((await revoke(helper)).error).toBeNull();
    expect(await hasInternal(helper, "leave.approve")).toBe(false);
  });
});

describe("never delegated", () => {
  it("keeps the plan, retention, API keys, the delegation and governance grants with the real owner", async () => {
    expect((await t.as(deputy.authId, "select public.set_prosm_time_retention(30, 30)")).error).toMatch(/ONLY THE OWNER/);
    expect((await t.as(deputy.authId, "select public.redeem_prosm_time_activation_code('ABC')")).error).toMatch(/ONLY THE OWNER/);
    expect((await t.as(deputy.authId, "select public.generate_prosm_time_api_key('erp', 'attendance:read')")).error).toMatch(/OWNER/);
    expect((await t.as(deputy.authId, "select public.grant_prosm_time_owner_authority($1, 'x')", [helper.userId])).error).toMatch(/ONLY THE OWNER/);
    expect((await t.as(deputy.authId, "select public.set_prosm_time_user_permission_override($1, 'permissions.assign', true, 'x')", [helper.userId])).error).toMatch(/ONLY THE OWNER GRANTS THIS PERMISSION/);
    // an ordinary permission can still be granted while covering
    expect((await t.as(deputy.authId, "select public.set_prosm_time_user_permission_override($1, 'reports.view', true, 'covering')", [helper.userId])).error).toBeNull();
  });
});

describe("no one decides their own request", () => {
  it("lets the deputy decide others' leave but not their own", async () => {
    const own = await t.as<{ r: { requestId: string } }>(deputy.authId, "select public.request_prosm_time_leave('annual', current_date + 30, current_date + 31, 'Trip') as r");
    expect(own.error).toBeNull();
    const ownId = own.rows![0].r.requestId;
    expect((await t.as(deputy.authId, "select public.review_prosm_time_leave($1, 'approved', null)", [ownId])).error).not.toBeNull();
    expect((await t.as(org.owner.authId, "select public.review_prosm_time_leave($1, 'approved', 'ok')", [ownId])).error).toBeNull();

    const other = await t.as<{ r: { requestId: string } }>(worker.authId, "select public.request_prosm_time_leave('annual', current_date + 40, current_date + 41, 'Family') as r");
    expect((await t.as(deputy.authId, "select public.review_prosm_time_leave($1, 'approved', null)", [other.rows![0].r.requestId])).error).toBeNull();
  });
});

describe("one permission rule", () => {
  it("gives a manager without a managed site only an employee's permissions, on the server too", async () => {
    expect((await permissions(siteless)).includes("sites.manage")).toBe(false);
    expect(await hasInternal(siteless, "sites.manage")).toBe(false);
    await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [site, siteless.userId]);
    expect(await hasInternal(siteless, "sites.manage")).toBe(true);
  });
});

describe("reading delegations and personal permissions", () => {
  it("is limited to the people concerned", async () => {
    const seen = await t.as<{ id: string }>(worker.authId, "select id from owner_delegations");
    expect(seen.rows).toEqual([]);
    const mine = await t.as<{ id: string }>(deputy.authId, "select id from owner_delegations");
    expect(mine.rows!.length).toBeGreaterThan(0);
    const overrides = await t.as<{ id: string }>(worker.authId, "select id from user_permission_overrides where user_id = $1", [helper.userId]);
    expect(overrides.rows).toEqual([]);
  });

  it("no longer answers 'is this person a delegate' for anyone", async () => {
    expect((await t.as(worker.authId, "select public.prosm_time_is_owner_delegate($1)", [deputy.userId])).error).toMatch(/permission denied/);
  });
});
