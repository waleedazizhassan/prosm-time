// PROSM Connect - the private Realtime channels' rules (realtime.messages), against a LOCAL Supabase
// (owner 2026-11-13: "test the realtime.messages permissions on a local Supabase, in a separate test file").
// Needs Docker and `npx supabase start`; then:
//   CONNECT_RT_URL=http://127.0.0.1:54321 CONNECT_RT_ANON=<local anon key> CONNECT_RT_SERVICE=<local service key> \
//   npx vitest run --config vitest.realtime.config.ts
// Without those variables every test here is skipped (the regular CI has no Supabase running).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const URL = process.env.CONNECT_RT_URL;
const ANON = process.env.CONNECT_RT_ANON;
const SERVICE = process.env.CONNECT_RT_SERVICE;
const live = Boolean(URL && ANON && SERVICE);

type Person = { client: SupabaseClient; userId: string; email: string };
let admin: SupabaseClient;
let orgId = "";
const people: Person[] = [];

async function person(name: string, roleKey = "employee"): Promise<Person> {
  const email = `rt-${name.toLowerCase()}-${Date.now()}@example.test`;
  const password = `Rt-${crypto.randomUUID()}`;
  const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const { data: role } = await admin.from("roles").select("id").eq("role_key", roleKey).single();
  const { data: user, error: userError } = await admin.from("users")
    .insert({ auth_user_id: created.user.id, organization_id: orgId, role_id: role!.id, full_name: name, email })
    .select("id").single();
  if (userError) throw userError;
  const client = createClient(URL!, ANON!, { auth: { persistSession: false } });
  await client.auth.signInWithPassword({ email, password });
  await client.realtime.setAuth((await client.auth.getSession()).data.session!.access_token);
  const p = { client, userId: user!.id as string, email };
  people.push(p);
  return p;
}

// joins a private channel; resolves "SUBSCRIBED" or the refusal
function join(p: Person, topic: string): Promise<string> {
  return new Promise((resolve) => {
    const channel = p.client.channel(topic, { config: { private: true } });
    const timer = setTimeout(() => resolve("TIMED_OUT"), 8000);
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR") {
        clearTimeout(timer);
        void p.client.removeChannel(channel);
        resolve(status);
      }
    });
  });
}

describe.skipIf(!live)("PROSM Connect private channels (local Supabase)", () => {
  let omar: Person;
  let hasan: Person;
  let mona: Person;

  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });
    const { data: org, error } = await admin.from("organizations").insert({ name: `RT ${Date.now()}` }).select("id").single();
    if (error) throw error;
    orgId = org!.id as string;
    omar = await person("Omar", "manager");
    hasan = await person("Hasan");
    mona = await person("Mona");
  }, 60000);

  afterAll(async () => {
    for (const p of people) await p.client.auth.signOut();
    if (orgId) await admin.from("organizations").delete().eq("id", orgId);
  });

  it("each joins their own channel and no one else's", async () => {
    expect(await join(hasan, `connect:user:${hasan.userId}`)).toBe("SUBSCRIBED");
    expect(await join(mona, `connect:user:${hasan.userId}`)).toBe("CHANNEL_ERROR");
  }, 30000);

  it("a conversation's channel is its members' only", async () => {
    const { data: conv } = await omar.client.rpc("prosm_time_connect_open_direct", { p_other: hasan.userId });
    expect(await join(hasan, `connect:conv:${conv}`)).toBe("SUBSCRIBED");
    expect(await join(mona, `connect:conv:${conv}`)).toBe("CHANNEL_ERROR");
  }, 30000);

  it("a new request reaches its recipient's channel at once", async () => {
    const got = new Promise<Record<string, unknown>>((resolve) => {
      const channel = hasan.client.channel(`connect:user:${hasan.userId}`, { config: { private: true } });
      channel.on("broadcast", { event: "item" }, (msg) => resolve(msg.payload as Record<string, unknown>)).subscribe(async (status) => {
        if (status !== "SUBSCRIBED") return;
        await omar.client.from("connect_switchboard").insert({ organization_id: orgId, from_user: omar.userId, to_user: hasan.userId, type: "message", body: "hi" });
      });
    });
    const payload = await got;
    expect(payload.type).toBe("message");
    expect(payload.from).toBe(omar.userId);
  }, 30000);
});
