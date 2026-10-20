// Audit 2026-10-12, item 1.1 - cross-tenant isolation. Two organisations
// with the same data; the owner, a manager (schedules.manage +
// exceptions.manage) and an employee of each query every org-scoped
// table and list/report RPC and must see nothing of the other one.
//
// Table-driven: every public table must be listed in TABLES (how to
// tell which organisation a row belongs to) or GLOBAL_TABLES (shared
// reference data) - a new table fails the coverage test until it is.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { buildDatabase, type TestDatabase } from "./support/db";
import { addMember, assignToSite, clockIn, createOrg, createSite, type TestMember, type TestOrg } from "./support/fixtures";

// SQL selecting the key of every row that belongs to organisation $1.
const byOrg = "select id from %t where organization_id = $1";
const byUser = "select id from %t where user_id in (select id from users where organization_id = $1)";
const TABLES: Record<string, string> = {
  admin_on_behalf_actions: byOrg,
  allowance_categories: byOrg,
  allowance_category_members: "select user_id as id from allowance_category_members where organization_id = $1",
  allowance_entries: byOrg,
  allowance_rates: byOrg,
  api_keys: byOrg,
  attendance_events: "select id from attendance_events where session_id in (select id from attendance_sessions where organization_id = $1)",
  attendance_sessions: byOrg,
  audit_logs: byOrg,
  break_events: byOrg,
  camera_evidence: byOrg,
  correction_requests: byOrg,
  device_bindings: byUser,
  exception_actions: byOrg,
  geofence_exceptions: byOrg,
  gusto_connections: byOrg,
  gusto_oauth_states: "select state as id from gusto_oauth_states where organization_id = $1",
  installation_identity: byOrg,
  leave_entitlements: byOrg,
  legal_acknowledgements: byOrg,
  push_devices: byOrg,
  leave_requests: byOrg,
  license_activation_state: byOrg,
  location_plausibility_flags: byOrg,
  location_samples: "select id from location_samples where presence_session_id in (select id from presence_sessions where organization_id = $1)",
  mock_location_flags: byOrg,
  notifications: byOrg,
  offline_time_reviews: byOrg,
  organization_settings: byOrg,
  organizations: "select id from organizations where id = $1",
  password_reset_requests: byUser,
  presence_sessions: byOrg,
  project_assignments: "select id from project_assignments where project_id in (select p.id from projects p join sites s on s.id = p.site_id where s.organization_id = $1)",
  projects: "select p.id from projects p join sites s on s.id = p.site_id where s.organization_id = $1",
  report_exports: byOrg,
  shift_assignments: byOrg,
  shift_templates: byOrg,
  site_assignments: "select id from site_assignments where site_id in (select id from sites where organization_id = $1)",
  site_change_events: byOrg,
  site_worker_attendance: byOrg,
  site_workers: byOrg,
  sites: byOrg,
  sos_alerts: byOrg,
  timesheet_approvals: byOrg,
  timesheet_corrections: byOrg,
  timesheets: byOrg,
  user_invitations: byUser,
  user_permission_overrides: byUser,
  users: byOrg,
  worker_pay_rates: byOrg,
  xero_connections: byOrg,
  xero_oauth_states: "select state as id from xero_oauth_states where organization_id = $1",
};
const GLOBAL_TABLES = ["permissions", "roles", "role_default_permissions", "security_rate_limits"];

// Tables the seed below must actually fill, so their check is not vacuous.
const MUST_BE_SEEDED = [
  "allowance_entries", "attendance_events", "attendance_sessions", "audit_logs", "break_events", "camera_evidence",
  "correction_requests", "device_bindings", "geofence_exceptions", "leave_entitlements", "leave_requests", "location_samples",
  "mock_location_flags", "notifications", "offline_time_reviews", "presence_sessions", "project_assignments", "projects", "report_exports", "shift_assignments",
  "shift_templates", "site_assignments", "site_change_events", "site_worker_attendance", "site_workers", "sites", "sos_alerts",
  "timesheet_approvals", "timesheets", "user_permission_overrides", "users", "worker_pay_rates",
];

const today = () => new Date().toISOString().slice(0, 10);
const daysFromNow = (days: number) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

interface SeededOrg {
  org: TestOrg;
  name: string;
  manager: TestMember;
  employee: TestMember;
  siteId: string;
  sessionId: string;
  timesheetId: string;
}

let t: TestDatabase;
let nile: SeededOrg;
let orbit: SeededOrg;

async function must(result: Promise<{ error: string | null }>, what: string) {
  const { error } = await result;
  if (error) throw new Error(`${what}: ${error}`);
}

async function seedOrg(name: string): Promise<SeededOrg> {
  const org = await createOrg(t, name);
  const siteId = await createSite(t, org, `${name} Tower`, { presenceMonitoring: true });
  await t.su("update sites set geofence_required = true where id = $1", [siteId]);
  const manager = await addMember(t, org, "manager", `${name} Manager`);
  const employee = await addMember(t, org, "employee", `${name} Employee`);
  const farEmployee = await addMember(t, org, "employee", `${name} Far Employee`);
  await t.su("insert into site_assignments (site_id, user_id, role_at_site) values ($1, $2, 'manager')", [siteId, manager.userId]);
  await assignToSite(t, siteId, employee);
  await assignToSite(t, siteId, farEmployee);
  for (const key of ["schedules.manage", "exceptions.manage"]) {
    await t.su(
      "insert into user_permission_overrides (user_id, permission_id, is_granted, reason) select $1, id, true, 'test' from permissions where permission_key = $2",
      [manager.userId, key],
    );
  }

  // Attendance: a shift with a break, then still clocked in; a far clock-in (geofence exception).
  await must(clockIn(t, employee, siteId), "clock in");
  const [session] = await t.su<{ id: string }>("select id from attendance_sessions where user_id = $1 and status = 'clocked_in'", [employee.userId]);
  await must(t.as(employee.authId, "select public.start_prosm_time_break($1, $2)", [session.id, randomUUID()]), "start break");
  const [activeBreak] = await t.su<{ id: string }>("select id from break_events where user_id = $1 and status = 'active'", [employee.userId]);
  await must(t.as(employee.authId, "select public.end_prosm_time_break($1, $2)", [activeBreak.id, randomUUID()]), "end break");
  await must(clockIn(t, farEmployee, siteId, { latitude: 30.3, longitude: 31.9 }), "far clock in");
  // An offline clock-in replayed an hour later (audit 1.4: a pending review).
  const offlineEmployee = await addMember(t, org, "employee", `${name} Offline Employee`);
  await assignToSite(t, siteId, offlineEmployee);
  await must(
    t.as(offlineEmployee.authId, "select public.clock_in_prosm_time_attendance($1, $2, null, $3, 30.02125, 31.75812, 8, null, null, null, true)", [randomUUID(), siteId, new Date(Date.now() - 3600e3).toISOString()]),
    "offline clock in",
  );
  // A clock-in from a simulated location (audit 2.4: a review item).
  const mockEmployee = await addMember(t, org, "employee", `${name} Mock Employee`);
  await assignToSite(t, siteId, mockEmployee);
  await must(
    t.as(mockEmployee.authId, "select public.clock_in_prosm_time_attendance($1, $2, null, null, 30.02125, 31.75812, 8, null, null, null, false, true)", [randomUUID(), siteId]),
    "mock clock in",
  );
  await must(t.as(employee.authId, "select public.trigger_prosm_time_shift_sos_alert($1)", [session.id]), "sos");

  const [event] = await t.su<{ id: string }>("select id from attendance_events where session_id = $1 limit 1", [session.id]);
  const [presence] = await t.su<{ id: string }>("select id from presence_sessions where attendance_session_id = $1", [session.id]);
  await t.su("insert into location_samples (presence_session_id, user_id, latitude, longitude, captured_at) values ($1, $2, 30.02, 31.75, now())", [presence.id, employee.userId]);
  await t.su(
    "insert into camera_evidence (organization_id, attendance_event_id, user_id, storage_path, content_type, file_size_bytes, captured_at, retention_expires_at) values ($1, $2, $3, $4, 'image/jpeg', 1, now(), now() + interval '30 days')",
    [org.id, event.id, employee.userId, `${name}/evidence.jpg`],
  );
  await t.su(
    "insert into correction_requests (organization_id, user_id, attendance_session_id, proposed_event_type, proposed_correct_time, reason) values ($1, $2, $3, 'clock_in', now(), 'forgot')",
    [org.id, employee.userId, session.id],
  );
  await t.su(
    "insert into site_change_events (organization_id, attendance_session_id, user_id, old_site_id, new_site_id, changed_at) values ($1, $2, $3, $4, $4, now())",
    [org.id, session.id, employee.userId, siteId],
  );
  await t.su("insert into device_bindings (user_id, device_identifier) values ($1, $2)", [employee.userId, `device-${name}`]);

  // Leave: a pending request reviewed by the owner, plus an entitlement.
  await must(t.as(employee.authId, "select public.request_prosm_time_leave('annual', $1, $1, $2)", [daysFromNow(30), `${name} family trip`]), "leave request");
  const [leave] = await t.su<{ id: string }>("select id from leave_requests where user_id = $1", [employee.userId]);
  await must(t.as(org.owner.authId, "select public.review_prosm_time_leave($1, 'approved', 'ok')", [leave.id]), "leave review");
  await t.su(
    "insert into leave_entitlements (organization_id, user_id, leave_type, year, entitled_days) values ($1, $2, 'annual', $3, 21) on conflict do nothing",
    [org.id, employee.userId, new Date().getFullYear()],
  );

  // Schedule.
  const [template] = await t.su<{ id: string }>(
    "insert into shift_templates (organization_id, site_id, name, start_time, end_time) values ($1, $2, $3, '08:00', '16:00') returning id",
    [org.id, siteId, `${name} morning`],
  );
  await t.su(
    "insert into shift_assignments (organization_id, user_id, site_id, shift_template_id, shift_date, start_time, end_time) values ($1, $2, $3, $4, $5, '08:00', '16:00')",
    [org.id, employee.userId, siteId, template.id, daysFromNow(1)],
  );

  // Timesheet: generated, submitted, approved.
  await must(t.as(org.owner.authId, "select public.generate_prosm_time_timesheet($1, $2, $3)", [employee.userId, daysFromNow(-6), today()]), "timesheet");
  const [timesheet] = await t.su<{ id: string }>("select id from timesheets where user_id = $1", [employee.userId]);
  await must(t.as(employee.authId, "select public.submit_prosm_time_timesheet($1)", [timesheet.id]), "submit timesheet");
  await must(t.as(org.owner.authId, "select public.approve_prosm_time_timesheet($1, 'approved', 'ok')", [timesheet.id]), "approve timesheet");

  // Everything else the app writes.
  await t.su("insert into allowance_entries (organization_id, user_id, attendance_session_id, entry_date, meal_allowance) values ($1, $2, $3, $4, 150)", [org.id, employee.userId, session.id, today()]);
  const [worker] = await t.su<{ id: string }>(
    "insert into site_workers (organization_id, site_id, full_name, worker_number) values ($1, $2, $3, '482913') returning id",
    [org.id, siteId, `${name} Worker`],
  );
  await t.su("insert into site_worker_attendance (organization_id, site_worker_id, site_id, clock_in_at, clock_in_latitude, clock_in_longitude) values ($1, $2, $3, now(), 30.02, 31.75)", [org.id, worker.id, siteId]);
  await t.su(
    "insert into worker_pay_rates (organization_id, site_worker_id, rate_type, rate_amount, currency, effective_from) values ($1, $2, 'HOURLY', 30, 'EGP', $3)",
    [org.id, worker.id, today()],
  );
  await t.su(
    "insert into report_exports (organization_id, exported_by, report_type, period_start, period_end, file_name, storage_path) values ($1, $2, 'attendance', $3, $3, 'x.pdf', $4)",
    [org.id, org.owner.userId, today(), `${name}/report.pdf`],
  );
  const [project] = await t.su<{ id: string }>("insert into projects (site_id, name) values ($1, $2) returning id", [siteId, `${name} project`]);
  await t.su("insert into project_assignments (project_id, user_id) values ($1, $2)", [project.id, employee.userId]);

  return { org, name, manager, employee, siteId, sessionId: session.id, timesheetId: timesheet.id };
}

// Every key of every row that belongs to the organisation, for the RPC result scan.
async function orgMarkers(seeded: SeededOrg): Promise<Set<string>> {
  const markers = new Set<string>([seeded.org.id]);
  for (const sql of Object.entries(TABLES).map(([table, template]) => template.replace("%t", table))) {
    for (const row of await t.su<{ id: string }>(sql, [seeded.org.id])) markers.add(String(row.id));
  }
  return markers;
}

beforeAll(async () => {
  t = await buildDatabase();
  nile = await seedOrg("Nile");
  orbit = await seedOrg("Orbit");
});

describe("cross-tenant isolation", () => {
  it("covers every public table", async () => {
    const tables = (await t.su<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public'")).map((row) => row.tablename);
    const unlisted = tables.filter((table) => !(table in TABLES) && !GLOBAL_TABLES.includes(table));
    expect(unlisted).toEqual([]);
  });

  it("seeds both organisations", async () => {
    for (const seeded of [nile, orbit]) {
      const empty: string[] = [];
      for (const table of MUST_BE_SEEDED) {
        const rows = await t.su(TABLES[table].replace("%t", table), [seeded.org.id]);
        if (rows.length === 0) empty.push(table);
      }
      expect(empty, `${seeded.name} has no rows in`).toEqual([]);
    }
  });

  for (const [readerOrgKey, otherOrgKey] of [["orbit", "nile"], ["nile", "orbit"]] as const) {
    for (const role of ["owner", "manager", "employee"] as const) {
      it(`${readerOrgKey} ${role} sees no ${otherOrgKey} rows in any table`, async () => {
        const reader = readerOrgKey === "orbit" ? orbit : nile;
        const other = otherOrgKey === "orbit" ? orbit : nile;
        const member = role === "owner" ? reader.org.owner : reader[role];
        const leaks: string[] = [];
        for (const [table, template] of Object.entries(TABLES)) {
          const ids = (await t.su<{ id: string }>(template.replace("%t", table), [other.org.id])).map((row) => String(row.id));
          if (ids.length === 0) continue;
          const keyColumn = template.startsWith("select state") ? "state" : "id";
          const seen = await t.as<{ n: number }>(member.authId, `select count(*)::int as n from ${table} where ${keyColumn}::text = any($1)`, [ids]);
          if (seen.error) continue; // no grant at all is isolation too
          if (seen.rows![0].n > 0) leaks.push(`${table}=${seen.rows![0].n}`);
        }
        expect(leaks).toEqual([]);
      });

      it(`${readerOrgKey} ${role} gets nothing of ${otherOrgKey} from list/report RPCs`, async () => {
        const reader = readerOrgKey === "orbit" ? orbit : nile;
        const other = otherOrgKey === "orbit" ? orbit : nile;
        const member = role === "owner" ? reader.org.owner : reader[role];
        const markers = await orgMarkers(other);
        const start = daysFromNow(-30);
        const end = daysFromNow(60);
        const year = new Date().getFullYear();
        const calls: Array<[string, unknown[]]> = [
          ["select * from public.list_prosm_time_visible_members()", []],
          ["select * from public.list_prosm_time_all_leave_requests()", []],
          ["select * from public.list_prosm_time_pending_leave_requests()", []],
          ["select * from public.list_prosm_time_approved_leave_requests(false)", []],
          ["select * from public.list_prosm_time_missing_clock_outs(0)", []],
          ["select * from public.list_prosm_time_nearby_sites(30.02125, 31.75812, 10)", []],
          ["select * from public.list_prosm_time_report_absences($1, $2)", [start, end]],
          ["select * from public.list_prosm_time_report_late($1, $2)", [start, end]],
          ["select * from public.list_prosm_time_report_leave_conflicts($1, $2)", [start, end]],
          ["select * from public.list_prosm_time_report_location_violations($1, $2)", [start, end]],
          ["select * from public.list_prosm_time_report_manager_overrides($1, $2)", [start, end]],
          ["select * from public.list_prosm_time_report_missing_checkouts($1, $2)", [start, end]],
          ["select * from public.list_prosm_time_report_site_summary($1, $2)", [start, end]],
          ["select * from public.list_prosm_time_report_workforce()", []],
          ["select * from public.list_prosm_time_report_exports(100)", []],
          ["select * from public.list_prosm_time_site_shifts($1, $2, $3)", [other.siteId, start, end]],
          ["select * from public.list_prosm_time_site_workers($1)", [other.siteId]],
          ["select * from public.list_prosm_time_site_worker_attendance($1, $2, $3)", [other.siteId, start, end]],
          ["select public.list_prosm_time_kiosk_roster($1) as r", [other.siteId]],
          ["select public.list_prosm_time_timesheet_entries($1) as r", [other.timesheetId]],
          ["select public.list_prosm_time_timesheet_evidence_pack($1) as r", [other.timesheetId]],
          ["select public.get_prosm_time_leave_balance($1, $2) as r", [other.employee.userId, year]],
          ["select public.get_prosm_time_session_summary($1) as r", [other.sessionId]],
          ["select * from public.list_prosm_time_attendance_export($1, now() - interval '30 days', now() + interval '1 day')", [other.org.id]],
          ["select * from public.list_prosm_time_allowances_export($1, $2, $3)", [other.org.id, start, end]],
          ["select * from public.list_prosm_time_leave_export($1, $2, $3)", [other.org.id, start, end]],
          ["select * from public.list_prosm_time_payroll_deductions_export($1, $2, $3)", [other.org.id, start, end]],
          ["select * from public.list_prosm_time_sites_export($1)", [other.org.id]],
          ["select * from public.list_prosm_time_workers_export($1)", [other.org.id]],
          ["select * from public.list_prosm_time_worker_rates_export($1, $2, $3)", [other.org.id, start, end]],
          ["select * from public.list_prosm_time_worker_attendance_export($1, now() - interval '30 days', now() + interval '1 day')", [other.org.id]],
        ];
        const leaks: string[] = [];
        for (const [sql, params] of calls) {
          const result = await t.as(member.authId, sql, params);
          if (result.error) continue; // refused is isolation
          const text = JSON.stringify(result.rows);
          const hit = [...markers].find((marker) => text.includes(marker)) ?? (text.includes(other.name) ? other.name : null);
          if (hit) leaks.push(`${sql.replace(/^select (\* from )?public\./, "").split("(")[0]} -> ${hit}`);
        }
        expect(leaks).toEqual([]);
      });
    }
  }

  it("still shows each organisation its own leave and shifts", async () => {
    for (const seeded of [nile, orbit]) {
      for (const table of ["leave_requests", "leave_entitlements", "shift_assignments"]) {
        const own = await t.as<{ n: number }>(seeded.org.owner.authId, `select count(*)::int as n from ${table} where organization_id = $1`, [seeded.org.id]);
        expect(own.rows![0].n, `${seeded.name} owner, ${table}`).toBeGreaterThan(0);
      }
      const managerShifts = await t.as<{ n: number }>(seeded.manager.authId, "select count(*)::int as n from shift_assignments");
      expect(managerShifts.rows![0].n).toBeGreaterThan(0);
      const employeeLeave = await t.as<{ n: number }>(seeded.employee.authId, "select count(*)::int as n from leave_requests");
      expect(employeeLeave.rows![0].n).toBe(1);
    }
  });

  it("leaves no owner shortcut without an organisation filter in any policy", async () => {
    const rows = await t.su(`select tablename, policyname from pg_policies
      where schemaname = 'public'
        and (coalesce(qual,'') || coalesce(with_check,'')) ilike '%is_owner()%'
        and (coalesce(qual,'') || coalesce(with_check,'')) not ilike '%organization_id%'
        and (coalesce(qual,'') || coalesce(with_check,'')) not ilike '%belongs_to_caller_org%'`);
    expect(rows).toEqual([]);
  });
});
