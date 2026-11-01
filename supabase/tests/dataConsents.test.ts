// 2026-11-01 (Privacy Policy v2, section 7): separate, dated consents per person
// and version; each person sees their own, the owner their organisation's.
import { describe, expect, it } from "vitest";

import { buildDatabase } from "./support/db";
import { addMember, createOrg } from "./support/fixtures";

describe("data consents", () => {
  it("records a dated consent once per version, visible to the person and their owner only", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Consent Co");
    const other = await createOrg(t, "Other Co");
    const worker = await addMember(t, org, "employee", "Worker");
    const colleague = await addMember(t, org, "employee", "Colleague");

    const record = "select public.record_prosm_time_consents('2026-10-31.2', array['eu_storage'])";
    expect((await t.as(worker.authId, record)).error).toBeNull();
    expect((await t.as(worker.authId, record)).error).toBeNull();
    expect((await t.as(worker.authId, "select public.record_prosm_time_consents('v', array['marketing'])")).error).not.toBeNull();

    const read = "select user_id, kind, accepted_at from data_consents";
    expect((await t.as(worker.authId, read)).rows).toHaveLength(1);
    expect((await t.as(org.owner.authId, read)).rows).toHaveLength(1);
    expect((await t.as(colleague.authId, read)).rows).toHaveLength(0);
    expect((await t.as(other.owner.authId, read)).rows).toHaveLength(0);
  });

  it("cannot be written directly", async () => {
    const t = await buildDatabase();
    const org = await createOrg(t, "Direct Co");
    const worker = await addMember(t, org, "employee", "Worker");
    const direct = await t.as(worker.authId, "insert into data_consents (organization_id, user_id, kind, policy_version) values ($1, $2, 'eu_storage', 'v')", [org.id, worker.userId]);
    expect(direct.error).not.toBeNull();
  });
});
