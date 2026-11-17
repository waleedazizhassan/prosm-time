// Owner 2026-11-17: only the Google Play builds (and the web) may talk to the server - public.prosm_time_client_gate,
// PostgREST's pre-request check, refuses an APK build, and every unnamed build once client_gate = 'require_marker'.
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";

let t: TestDatabase;

async function gate(role: string, clientInfo: string | null): Promise<string | null> {
  await t.su("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ role })]);
  await t.su("select set_config('request.headers', $1, false)", [JSON.stringify(clientInfo === null ? {} : { "x-client-info": clientInfo })]);
  try {
    await t.su("select public.prosm_time_client_gate()");
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("client gate", () => {
  beforeAll(async () => {
    t = await buildDatabase();
    expect(t.failures).toEqual([]);
  });

  it("lets the Play and web builds in, refuses an APK build", async () => {
    expect(await gate("authenticated", "prosm-time/play/2.4.6")).toBeNull();
    expect(await gate("anon", "prosm-time/web/2.4.6")).toBeNull();
    expect(await gate("authenticated", "prosm-time/direct/2.4.6")).toMatch(/APP_BUILD_NOT_SUPPORTED/);
  });

  it("lets unnamed (old) builds in until require_marker, then refuses them", async () => {
    expect(await gate("authenticated", "supabase-js-web/2.45.0")).toBeNull();
    expect(await gate("anon", null)).toBeNull();
    await t.su("update platform_settings set value = '\"require_marker\"'::jsonb where key = 'client_gate'");
    expect(await gate("authenticated", "supabase-js-web/2.45.0")).toMatch(/APP_BUILD_NOT_SUPPORTED/);
    expect(await gate("anon", null)).toMatch(/APP_BUILD_NOT_SUPPORTED/);
    expect(await gate("authenticated", "prosm-time/play/2.4.6")).toBeNull();
  });

  it("never touches the server's own calls", async () => {
    expect(await gate("service_role", null)).toBeNull();
    expect(await gate("service_role", "prosm-time/direct/1.0")).toBeNull();
  });
});
