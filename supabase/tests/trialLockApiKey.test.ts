// v2.3.43 step 21 (audit, owner: "the 30-day trial must not be tampered
// with"): an ended trial locks the organisation for its members; the export
// API key (service role) must be locked too, and work again on renewal.
// Migration 20261026100000.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { createOrg, type TestOrg } from "./support/fixtures";

let t: TestDatabase;
let org: TestOrg;

const authenticate = async (raw: string) => (await t.su<{ org: string | null }>("select public.authenticate_prosm_time_api_key($1) as org", [raw]))[0].org;

beforeAll(async () => {
  t = await buildDatabase();
  org = await createOrg(t, "Trial Co");
  await t.su(
    "insert into api_keys (organization_id, name, key_hash, key_prefix) values ($1, 'payroll', encode(sha256(convert_to('raw-key-1', 'utf8')), 'hex'), 'raw-')",
    [org.id],
  );
});

describe("export API key and the trial lock", () => {
  it("works while the organisation is active", async () => {
    expect(await authenticate("raw-key-1")).toBe(org.id);
    expect(await authenticate("wrong")).toBeNull();
  });

  it("answers nothing once the trial has ended", async () => {
    await t.su("update license_activation_state set is_trial = true, expires_at = now() - interval '1 minute' where organization_id = $1", [org.id]);
    expect(await authenticate("raw-key-1")).toBeNull();
  });

  it("works again when the license is renewed", async () => {
    await t.su("update license_activation_state set expires_at = now() + interval '30 days' where organization_id = $1", [org.id]);
    expect(await authenticate("raw-key-1")).toBe(org.id);
  });

  it("is not callable by a signed-in user or anonymously", async () => {
    const result = await t.as(org.owner.authId, "select public.authenticate_prosm_time_api_key('raw-key-1')");
    expect(result.error).toMatch(/permission denied/i);
  });
});
