import DatabaseManager from "../database/DatabaseManager";

export interface ServiceResult<T = null> {
  success: boolean;
  message: string | null;
  data: T | null;
}

export interface AttendanceEventLocation {
  latitude: number;
  longitude: number;
  // null when the event had no site to check against (e.g. a manual
  // workplace label) - "not checked", distinct from a real mismatch.
  withinGeofence: boolean | null;
}

export interface TodayAttendanceRow {
  sessionId: string;
  userId: string;
  userFullName: string;
  siteName: string;
  status: "clocked_in" | "clocked_out";
  clockInAt: string;
  clockOutAt: string | null;
  hasActivePresence: boolean;
  clockInEvidencePath: string | null;
  clockOutEvidencePath: string | null;
  // § live UX review, user-directed - "next to the site name, show the
  // real GPS location captured at clock-in/out, plus whether it
  // matched the site." Already captured by every clock-in/out
  // regardless of whether a site was selected (ClockInOutCard always
  // calls getUserPosition first) - this was only ever a display gap.
  clockInLocation: AttendanceEventLocation | null;
  clockOutLocation: AttendanceEventLocation | null;
  // § live UX review, user-directed - the optional note/activity typed
  // into the new attendance confirmation screen, shown to managers in
  // the Attendance Record. Per-event (note/activity can differ between
  // the clock-in and the clock-out of the same session).
  clockInNote: string | null;
  clockInActivity: string | null;
  clockOutNote: string | null;
  clockOutActivity: string | null;
  // § live UX review, user-directed - "Change Site" mid-shift: show the
  // move inline under the site name ("changed to X at HH:MM"), same
  // "the record itself carries what happened" posture as the evidence-
  // photo icons above.
  siteChanges: SiteChangeEntry[];
}

export interface SiteChangeEntry {
  fromSiteName: string | null;
  toSiteName: string;
  changedAt: string;
}

export interface PendingReviewItem {
  kind: "geofence_exception" | "correction_request";
  id: string;
  userFullName: string;
  summary: string;
  createdAt: string;
}

interface RawUserRef {
  full_name: string | null;
}

interface RawAttendanceSessionRow {
  id: string;
  user_id: string;
  status: "clocked_in" | "clocked_out";
  clock_in_at: string;
  clock_out_at: string | null;
  manual_location_label: string | null;
  users: RawUserRef | RawUserRef[] | null;
  sites: { name: string | null } | { name: string | null }[] | null;
}

interface RawAttendanceEventRow {
  id: string;
  session_id: string;
  event_type: "clock_in" | "clock_out";
  latitude: number | null;
  longitude: number | null;
  within_geofence: boolean | null;
  note: string | null;
  activity: string | null;
}

interface RawCameraEvidenceRow {
  attendance_event_id: string;
  storage_path: string;
}

interface RawSiteChangeRow {
  attendance_session_id: string;
  changed_at: string;
  old_site: { name: string } | { name: string }[] | null;
  new_site: { name: string } | { name: string }[] | null;
}

interface RawGeofenceExceptionRow {
  id: string;
  distance_meters: number;
  employee_reason: string | null;
  created_at: string;
  users: RawUserRef | RawUserRef[] | null;
}

interface RawCorrectionRequestRow {
  id: string;
  proposed_event_type: string;
  proposed_correct_time: string;
  reason: string;
  created_at: string;
  users: RawUserRef | RawUserRef[] | null;
}

// § live UX review, user-directed - "SOS/emergency alerts need a real
// log: the exact GPS location, the time, the employee's name, the
// work site, and everything about the site and the employee." Backed
// entirely by the WP-10 sos_alerts table (§18) and its already-live
// resolve_prosm_time_sos_alert RPC - both existed with zero frontend
// caller until now.
export interface SosAlertRow {
  id: string;
  userFullName: string;
  userEmail: string;
  siteId: string | null;
  siteName: string;
  siteDisplayAddress: string | null;
  triggeredAt: string;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  status: "active" | "resolved";
  resolvedAt: string | null;
  resolutionNotes: string | null;
}

interface RawUserRefWithEmail {
  full_name: string | null;
  email: string | null;
}

interface RawPresenceSiteRef {
  site_id: string;
  sites: { name: string | null; display_address: string | null } | { name: string | null; display_address: string | null }[] | null;
}

interface RawSosAlertRow {
  id: string;
  triggered_at: string;
  latitude: number | null;
  longitude: number | null;
  accuracy_meters: number | null;
  status: "active" | "resolved";
  resolved_at: string | null;
  resolution_notes: string | null;
  users: RawUserRefWithEmail | RawUserRefWithEmail[] | null;
  presence_sessions: RawPresenceSiteRef | RawPresenceSiteRef[] | null;
}

function createSuccess<T>(data: T | null = null): ServiceResult<T> {
  return { success: true, message: null, data };
}
function createError<T>(message: string): ServiceResult<T> {
  return { success: false, message, data: null };
}

// PROSM Time WP-14/§21 - "Operational dashboard... Exceptions and
// approvals." No new RPCs needed - geofence_exceptions/correction_
// requests/attendance_sessions RLS grants each caller exactly what
// they are authorized to see (their own rows always; an org-wide
// read additionally scoped to the caller's own managed sites for
// attendance.view holders, unscoped for the Owner - 20260902090000);
// this repository is purely the aggregation queries Manager Console
// and the Attendance Record screen need, on top of that same RLS.
class ManagerRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  // Shared by listTodayAttendance and listAttendanceHistory - only the
  // clock_in_at range differs between "today" and an arbitrary
  // caller-picked period; the session/presence/evidence joins and row
  // shaping are otherwise identical.
  private async fetchAttendanceRows(fromIso: string, toIso?: string, includeOpenSessions = false): Promise<ServiceResult<TodayAttendanceRow[]>> {
    try {
      let sessionsQuery = this.client
        .from("attendance_sessions")
        .select("id, user_id, status, clock_in_at, clock_out_at, manual_location_label, users(full_name), sites(name)")
        .order("clock_in_at", { ascending: false });

      // Real bug fix - listTodayAttendance's own "Currently present" KPI
      // used a plain clock_in_at >= startOfDay filter, so anyone who
      // clocked in before local midnight and simply never clocked out
      // (still status='clocked_in') silently vanished from Currently
      // Present the instant the calendar day rolled over, despite the
      // Attendance Record still correctly showing them as clocked in
      // (it queries the same rows, unfiltered by this bug). An open
      // session belongs in "today" regardless of when its own clock-in
      // happened - only listAttendanceHistory's own caller-picked range
      // (includeOpenSessions left false) should stay a strict date filter.
      if (includeOpenSessions) {
        sessionsQuery = sessionsQuery.or(`clock_in_at.gte.${fromIso},status.eq.clocked_in`);
      } else {
        sessionsQuery = sessionsQuery.gte("clock_in_at", fromIso);
      }
      if (toIso) sessionsQuery = sessionsQuery.lte("clock_in_at", toIso);

      const [sessionsResult, presenceResult] = await Promise.all([
        sessionsQuery,
        this.client.from("presence_sessions").select("attendance_session_id").eq("status", "active"),
      ]);

      if (sessionsResult.error) return createError(sessionsResult.error.message);

      const activePresenceIds = new Set((presenceResult.data ?? []).map((row: { attendance_session_id: string }) => row.attendance_session_id));

      const sessionIds = ((sessionsResult.data ?? []) as RawAttendanceSessionRow[]).map((row) => row.id);

      // PROSM Time - live UX review: "the photo the employee captures
      // should show next to the clock-in time, and the clock-out photo
      // next to the clock-out time." attendance_events/camera_evidence
      // are only joined for today's sessions (not a global fetch), and
      // storage paths only - no eager download here, EvidenceRepository
      // downloads on demand when the manager opens a thumbnail.
      const clockInEvidenceBySession = new Map<string, string>();
      const clockOutEvidenceBySession = new Map<string, string>();
      const clockInLocationBySession = new Map<string, AttendanceEventLocation>();
      const clockOutLocationBySession = new Map<string, AttendanceEventLocation>();
      const clockInNoteBySession = new Map<string, string>();
      const clockInActivityBySession = new Map<string, string>();
      const clockOutNoteBySession = new Map<string, string>();
      const clockOutActivityBySession = new Map<string, string>();
      if (sessionIds.length > 0) {
        const eventsResult = await this.client
          .from("attendance_events")
          .select("id, session_id, event_type, latitude, longitude, within_geofence, note, activity")
          .in("session_id", sessionIds)
          .in("event_type", ["clock_in", "clock_out"]);
        if (eventsResult.error) return createError(eventsResult.error.message);

        const events = (eventsResult.data ?? []) as RawAttendanceEventRow[];
        const eventIds = events.map((event) => event.id);

        const evidenceByEvent = new Map<string, string>();
        if (eventIds.length > 0) {
          const evidenceResult = await this.client.from("camera_evidence").select("attendance_event_id, storage_path").in("attendance_event_id", eventIds).order("captured_at", { ascending: true });
          if (evidenceResult.error) return createError(evidenceResult.error.message);
          for (const evidenceRow of (evidenceResult.data ?? []) as RawCameraEvidenceRow[]) {
            if (!evidenceByEvent.has(evidenceRow.attendance_event_id)) evidenceByEvent.set(evidenceRow.attendance_event_id, evidenceRow.storage_path);
          }
        }

        for (const event of events) {
          const storagePath = evidenceByEvent.get(event.id);
          if (storagePath) {
            if (event.event_type === "clock_in") clockInEvidenceBySession.set(event.session_id, storagePath);
            else clockOutEvidenceBySession.set(event.session_id, storagePath);
          }

          if (event.latitude !== null && event.longitude !== null) {
            const location: AttendanceEventLocation = { latitude: event.latitude, longitude: event.longitude, withinGeofence: event.within_geofence };
            if (event.event_type === "clock_in") clockInLocationBySession.set(event.session_id, location);
            else clockOutLocationBySession.set(event.session_id, location);
          }

          if (event.note) {
            if (event.event_type === "clock_in") clockInNoteBySession.set(event.session_id, event.note);
            else clockOutNoteBySession.set(event.session_id, event.note);
          }
          if (event.activity) {
            if (event.event_type === "clock_in") clockInActivityBySession.set(event.session_id, event.activity);
            else clockOutActivityBySession.set(event.session_id, event.activity);
          }
        }
      }

      // § live UX review, user-directed - the mid-shift "Change Site"
      // move, joined the same way evidence/location are above (only
      // for the sessions already being fetched).
      const siteChangesBySession = new Map<string, SiteChangeEntry[]>();
      if (sessionIds.length > 0) {
        const changesResult = await this.client
          .from("site_change_events")
          .select("attendance_session_id, changed_at, old_site:sites!site_change_events_old_site_id_fkey(name), new_site:sites!site_change_events_new_site_id_fkey(name)")
          .in("attendance_session_id", sessionIds)
          .order("changed_at", { ascending: true });
        if (changesResult.error) return createError(changesResult.error.message);

        for (const changeRow of (changesResult.data ?? []) as RawSiteChangeRow[]) {
          const oldSite = Array.isArray(changeRow.old_site) ? changeRow.old_site[0] : changeRow.old_site;
          const newSite = Array.isArray(changeRow.new_site) ? changeRow.new_site[0] : changeRow.new_site;
          const entry: SiteChangeEntry = { fromSiteName: oldSite?.name ?? null, toSiteName: newSite?.name ?? "", changedAt: changeRow.changed_at };
          const existing = siteChangesBySession.get(changeRow.attendance_session_id) ?? [];
          existing.push(entry);
          siteChangesBySession.set(changeRow.attendance_session_id, existing);
        }
      }

      const rows = ((sessionsResult.data ?? []) as RawAttendanceSessionRow[]).map((row) => {
        const user = Array.isArray(row.users) ? row.users[0] : row.users;
        const site = Array.isArray(row.sites) ? row.sites[0] : row.sites;
        return {
          sessionId: row.id,
          userId: row.user_id,
          userFullName: user?.full_name ?? "",
          // § live UX review, user-directed - a no-site clock-in now
          // requires a free-text workplace label instead of leaving
          // this blank (manual_location_label, 20260902120000) - a
          // real site's name always wins when one exists.
          siteName: site?.name ?? row.manual_location_label ?? "",
          status: row.status,
          clockInAt: row.clock_in_at,
          clockOutAt: row.clock_out_at,
          hasActivePresence: activePresenceIds.has(row.id),
          clockInEvidencePath: clockInEvidenceBySession.get(row.id) ?? null,
          clockOutEvidencePath: clockOutEvidenceBySession.get(row.id) ?? null,
          clockInLocation: clockInLocationBySession.get(row.id) ?? null,
          clockOutLocation: clockOutLocationBySession.get(row.id) ?? null,
          clockInNote: clockInNoteBySession.get(row.id) ?? null,
          clockInActivity: clockInActivityBySession.get(row.id) ?? null,
          clockOutNote: clockOutNoteBySession.get(row.id) ?? null,
          clockOutActivity: clockOutActivityBySession.get(row.id) ?? null,
          siteChanges: siteChangesBySession.get(row.id) ?? [],
        };
      });

      return createSuccess(rows);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Manager console service unavailable.");
    }
  }

  async listTodayAttendance(): Promise<ServiceResult<TodayAttendanceRow[]>> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return this.fetchAttendanceRows(startOfDay.toISOString(), undefined, true);
  }

  // Attendance Record screen - same underlying rows as
  // listTodayAttendance, just over a caller-picked calendar range
  // instead of a hardcoded "today". startDate/endDate are plain
  // "YYYY-MM-DD" strings from a date input; expanded to that day's
  // full local start/end before querying so the end date is inclusive.
  async listAttendanceHistory(startDate: string, endDate: string): Promise<ServiceResult<TodayAttendanceRow[]>> {
    const from = new Date(`${startDate}T00:00:00`);
    const to = new Date(`${endDate}T23:59:59.999`);
    return this.fetchAttendanceRows(from.toISOString(), to.toISOString());
  }

  async listPendingReview(): Promise<ServiceResult<PendingReviewItem[]>> {
    try {
      const [exceptionsResult, correctionsResult] = await Promise.all([
        this.client.from("geofence_exceptions").select("id, distance_meters, employee_reason, created_at, users(full_name)").eq("status", "pending_review"),
        this.client.from("correction_requests").select("id, proposed_event_type, proposed_correct_time, reason, created_at, users(full_name)").eq("status", "pending"),
      ]);

      if (exceptionsResult.error) return createError(exceptionsResult.error.message);
      if (correctionsResult.error) return createError(correctionsResult.error.message);

      const exceptionItems: PendingReviewItem[] = ((exceptionsResult.data ?? []) as RawGeofenceExceptionRow[]).map((row) => {
        const user = Array.isArray(row.users) ? row.users[0] : row.users;
        return {
          kind: "geofence_exception" as const,
          id: row.id,
          userFullName: user?.full_name ?? "",
          summary: `${Math.round(row.distance_meters)} m outside area - ${row.employee_reason ?? ""}`,
          createdAt: row.created_at,
        };
      });

      const correctionItems: PendingReviewItem[] = ((correctionsResult.data ?? []) as RawCorrectionRequestRow[]).map((row) => {
        const user = Array.isArray(row.users) ? row.users[0] : row.users;
        return {
          kind: "correction_request" as const,
          id: row.id,
          userFullName: user?.full_name ?? "",
          summary: `${row.proposed_event_type} -> ${new Date(row.proposed_correct_time).toLocaleString()} - ${row.reason}`,
          createdAt: row.created_at,
        };
      });

      return createSuccess([...exceptionItems, ...correctionItems].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Manager console service unavailable.");
    }
  }

  // Emergency Log - same "own picked date range" shape as
  // listAttendanceHistory. sos_alerts' own RLS already scopes rows to
  // the alerting employee, attendance.view holders, or the Owner - no
  // extra filtering needed here.
  async listSosAlerts(startDate: string, endDate: string): Promise<ServiceResult<SosAlertRow[]>> {
    try {
      const from = new Date(`${startDate}T00:00:00`).toISOString();
      const to = new Date(`${endDate}T23:59:59.999`).toISOString();

      const { data, error } = await this.client
        .from("sos_alerts")
        .select(
          // sos_alerts has two FKs into users (user_id - the alerting
          // employee - and resolved_by), so a bare "users(...)" embed
          // is ambiguous to PostgREST and fails to load entirely
          // (PGRST201). The !sos_alerts_user_id_fkey hint picks the
          // alerting employee's own relationship explicitly.
          "id, triggered_at, latitude, longitude, accuracy_meters, status, resolved_at, resolution_notes, users!sos_alerts_user_id_fkey(full_name, email), presence_sessions(site_id, sites(name, display_address))",
        )
        .gte("triggered_at", from)
        .lte("triggered_at", to)
        .order("triggered_at", { ascending: false });

      if (error) return createError(error.message);

      const rows: SosAlertRow[] = ((data ?? []) as RawSosAlertRow[]).map((row) => {
        const user = Array.isArray(row.users) ? row.users[0] : row.users;
        const presenceSession = Array.isArray(row.presence_sessions) ? row.presence_sessions[0] : row.presence_sessions;
        const site = presenceSession ? (Array.isArray(presenceSession.sites) ? presenceSession.sites[0] : presenceSession.sites) : null;
        return {
          id: row.id,
          userFullName: user?.full_name ?? "",
          userEmail: user?.email ?? "",
          siteId: presenceSession?.site_id ?? null,
          siteName: site?.name ?? "",
          siteDisplayAddress: site?.display_address ?? null,
          triggeredAt: row.triggered_at,
          latitude: row.latitude,
          longitude: row.longitude,
          accuracyMeters: row.accuracy_meters,
          status: row.status,
          resolvedAt: row.resolved_at,
          resolutionNotes: row.resolution_notes,
        };
      });

      return createSuccess(rows);
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Manager console service unavailable.");
    }
  }

  async resolveSosAlert(sosAlertId: string, resolutionNotes?: string): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.rpc("resolve_prosm_time_sos_alert", {
        p_sos_alert_id: sosAlertId,
        p_resolution_notes: resolutionNotes?.trim() || null,
      });
      if (error) return createError(error.message);
      if (data?.success === false) return createError("Unable to resolve this alert.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Manager console service unavailable.");
    }
  }

  async reviewItem(kind: "geofence_exception" | "correction_request", targetId: string, actionType: string, notes?: string): Promise<ServiceResult> {
    try {
      const { data, error } = await this.client.functions.invoke("review-exception", {
        body: { kind, targetId, actionType, notes: notes ?? null },
      });
      if (error) {
        const errorBody = await error.context?.json?.().catch(() => null);
        return createError(errorBody?.error?.message ?? error.message ?? "Unable to review this item.");
      }
      if (data?.success === false) return createError(data?.error?.message ?? "Unable to review this item.");
      return createSuccess();
    } catch (error) {
      return createError(error instanceof Error ? error.message : "Manager console service unavailable.");
    }
  }
}

export default new ManagerRepository();
