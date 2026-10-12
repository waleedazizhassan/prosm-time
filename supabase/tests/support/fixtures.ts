// Organisation / member fixtures shared by the database test suites.
import { randomUUID } from "node:crypto";

import type { TestDatabase } from "./db";

export interface TestMember {
  authId: string;
  userId: string;
  email: string;
}

export interface TestOrg {
  id: string;
  owner: TestMember;
}

export async function createOrg(t: TestDatabase, name: string): Promise<TestOrg> {
  const authId = randomUUID();
  const email = `owner-${name.toLowerCase()}-${authId.slice(0, 6)}@test.local`;
  await t.su("insert into auth.users (id, email) values ($1, $2)", [authId, email]);
  await t.su(
    "select public.bootstrap_prosm_time_organization($1, $2, $3, $4, $5, null, 50, 10, now() + interval '1 year', $6)",
    [name, authId, email, `Owner ${name}`, `LIC-${name}-${authId.slice(0, 6)}`, `${name} main site`],
  );
  const [user] = await t.su<{ id: string; organization_id: string }>("select id, organization_id from users where auth_user_id = $1", [authId]);
  await t.su("update license_activation_state set status = 'active', expires_at = now() + interval '1 year' where organization_id = $1", [user.organization_id]).catch(() => undefined);
  return { id: user.organization_id, owner: { authId, userId: user.id, email } };
}

export async function addMember(t: TestDatabase, org: TestOrg, roleKey: string, fullName: string): Promise<TestMember> {
  const authId = randomUUID();
  const email = `${roleKey}-${authId.slice(0, 8)}@test.local`;
  await t.su("insert into auth.users (id, email) values ($1, $2)", [authId, email]);
  const [role] = await t.su<{ id: string }>("select id from roles where role_key = $1", [roleKey]);
  const [user] = await t.su<{ id: string }>(
    "insert into users (auth_user_id, organization_id, role_id, email, full_name, status, is_owner, is_active) values ($1, $2, $3, $4, $5, 'active', false, true) returning id",
    [authId, org.id, role.id, email, fullName],
  );
  return { authId, userId: user.id, email };
}

export async function createSite(
  t: TestDatabase,
  org: TestOrg,
  name: string,
  options: { latitude?: number; longitude?: number; radius?: number; presenceMonitoring?: boolean } = {},
): Promise<string> {
  const latitude = options.latitude ?? 30.0212;
  const longitude = options.longitude ?? 31.7581;
  const result = await t.as(org.owner.authId, "select public.create_prosm_time_site($1, $2, $3, $4, $5)", [name, latitude, longitude, `${name} address`, options.radius ?? 150]);
  if (result.error) throw new Error(`create site failed: ${result.error}`);
  const [site] = await t.su<{ id: string }>("select id from sites where organization_id = $1 and name = $2", [org.id, name]);
  await t.su("update sites set presence_monitoring_enabled = $2 where id = $1", [site.id, options.presenceMonitoring ?? false]);
  return site.id;
}

export async function assignToSite(t: TestDatabase, siteId: string, member: TestMember): Promise<void> {
  await t.su("insert into site_assignments (site_id, user_id) values ($1, $2)", [siteId, member.userId]);
}

// Live (online) clock-in at the site's own coordinates.
export async function clockIn(t: TestDatabase, member: TestMember, siteId: string | null, at: { latitude?: number; longitude?: number } = {}) {
  return t.as(member.authId, "select public.clock_in_prosm_time_attendance($1, $2, null, null, $3, $4, 8) as r", [
    randomUUID(),
    siteId,
    at.latitude ?? 30.02125,
    at.longitude ?? 31.75812,
  ]);
}

export async function clockOut(t: TestDatabase, member: TestMember) {
  return t.as(member.authId, "select public.clock_out_prosm_time_attendance($1, null, 30.02125, 31.75812, 8) as r", [randomUUID()]);
}

export async function openSessionId(t: TestDatabase, member: TestMember): Promise<string | null> {
  const [row] = await t.su<{ id: string }>("select id from attendance_sessions where user_id = $1 and status = 'clocked_in' limit 1", [member.userId]);
  return row?.id ?? null;
}
