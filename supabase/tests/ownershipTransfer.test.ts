// Governance phase E (owner 2026-11-15, report section 8.5-f): the owner changes only through a transfer -
// started by the real owner, accepted by the recipient, 72 hours of waiting, cancellable until it completes, never
// by a deputy. Completing switches the owner in one step; the users trigger lets only that path through.
// Migration 20261115150000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, createOrg, type TestMember, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;
let heir: TestMember;
let deputy: TestMember;

const ownerOf = async () => (await t.su<{ id: string }>("select id from users where organization_id = $1 and is_owner", [org.id]))[0]?.id;

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Heritage");
  heir = await addMember(t, org, "manager", "Heir");
  deputy = await addMember(t, org, "manager", "Deputy");
  expect((await t.as(org.owner.authId, "select public.grant_prosm_time_owner_authority($1, 'travel')", [deputy.userId])).error).toBeNull();
});

describe("ownership transfer", () => {
  let transferId: string;

  it("only the real owner starts it, with a reason, to an active member; a deputy cannot", async () => {
    expect((await t.as(deputy.authId, "select public.start_prosm_time_ownership_transfer($1, 'take')", [heir.userId])).error).toMatch(/ONLY THE OWNER/);
    expect((await t.as(org.owner.authId, "select public.start_prosm_time_ownership_transfer($1, '')", [heir.userId])).error).toMatch(/REASON/);
    const started = await t.as<{ r: { transferId: string } }>(org.owner.authId, "select public.start_prosm_time_ownership_transfer($1, 'retiring') as r", [heir.userId]);
    expect(started.error).toBeNull();
    transferId = started.rows![0].r.transferId;
    expect((await t.as(org.owner.authId, "select public.start_prosm_time_ownership_transfer($1, 'again')", [deputy.userId])).error).toMatch(/ALREADY OPEN/);
  });

  it("does not complete without the recipient's acceptance, nor before the 72 hours", async () => {
    expect((await t.as(org.owner.authId, "select public.complete_prosm_time_ownership_transfer($1)", [transferId])).error).toMatch(/NOT READY/);
    expect((await t.as(deputy.authId, "select public.accept_prosm_time_ownership_transfer($1)", [transferId])).error).toMatch(/NOT FOUND/);
    expect((await t.as(heir.authId, "select public.accept_prosm_time_ownership_transfer($1)", [transferId])).error).toBeNull();
    expect((await t.as(heir.authId, "select public.complete_prosm_time_ownership_transfer($1)", [transferId])).error).toMatch(/WAITING PERIOD/);
    expect(await ownerOf()).toBe(org.owner.userId);
  });

  it("nobody can call the switch directly", async () => {
    expect((await t.as(org.owner.authId, "select public.prosm_time_complete_ownership_switch($1)", [transferId])).error).toMatch(/permission denied/);
  });

  it("after the wait it completes: the heir owns, the old owner is a manager, delegations end, it is recorded", async () => {
    await t.su("update ownership_transfers set cooling_until = now() - interval '1 minute' where id = $1", [transferId]);
    expect((await t.as(heir.authId, "select public.complete_prosm_time_ownership_transfer($1)", [transferId])).error).toBeNull();
    expect(await ownerOf()).toBe(heir.userId);
    const [old] = await t.su<{ role_key: string; is_active: boolean }>("select r.role_key, u.is_active from users u join roles r on r.id = u.role_id where u.id = $1", [org.owner.userId]);
    expect(old).toEqual({ role_key: "manager", is_active: true });
    expect((await t.su("select 1 from owner_delegations where organization_id = $1 and revoked_at is null", [org.id])).length).toBe(0);
    expect((await t.su("select 1 from audit_logs where action = 'OWNERSHIP_TRANSFERRED' and entity_id = $1", [transferId])).length).toBe(1);
  });

  it("can be cancelled while waiting, and is recorded", async () => {
    const other = await createOrg(t, "Second");
    const member = await addMember(t, other, "manager", "M");
    const started = await t.as<{ r: { transferId: string } }>(other.owner.authId, "select public.start_prosm_time_ownership_transfer($1, 'x') as r", [member.userId]);
    const id = started.rows![0].r.transferId;
    expect((await t.as(member.authId, "select public.accept_prosm_time_ownership_transfer($1)", [id])).error).toBeNull();
    expect((await t.as(other.owner.authId, "select public.cancel_prosm_time_ownership_transfer($1)", [id])).error).toBeNull();
    expect((await t.su("select 1 from audit_logs where action = 'OWNERSHIP_TRANSFER_CANCELLED' and entity_id = $1", [id])).length).toBe(1);
    await t.su("update ownership_transfers set cooling_until = now() - interval '1 minute' where id = $1", [id]);
    expect((await t.as(member.authId, "select public.complete_prosm_time_ownership_transfer($1)", [id])).error).toMatch(/NOT READY/);
  });
});
