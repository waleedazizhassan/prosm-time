// Owner 2026-10-20: one answer to "where does tapping this notification go",
// shared by the in-app bell and the phone's push notifications (they used to
// disagree). The type decides first, then the record it is about. Each
// notification opens the page where its reader can act on it.

export interface NotificationRef {
  type?: unknown;
  /** The related record's table, e.g. "leave_requests" (push: data.entityType; bell: relatedEntityType). */
  entityType?: unknown;
  /** The notification's data.kind, when known (the bell has it; a push tap doesn't). */
  kind?: unknown;
}

export interface NotificationViewer {
  isOwner: boolean;
  /** Can open the Emergency Log (attendance.view). */
  canViewEmergencyLog: boolean;
}

export default function notificationTarget(ref: NotificationRef | undefined, viewer: NotificationViewer): string {
  const type = String(ref?.type ?? "");
  const isLeave = ref?.kind === "leave" || ref?.entityType === "leave_requests";

  switch (type) {
    case "sos_alert":
      return viewer.isOwner || viewer.canViewEmergencyLog ? "/emergency-log" : "/dashboard";
    // Leave requests are reviewed on the Manager Console too.
    case "exception_pending_review":
    case "correction_submitted":
    case "site_change_alert":
    case "location_plausibility_flag":
    case "out_of_zone_manager":
    case "missing_clock_out":
      return "/manager";
    // The employee's exceptions card lives on the dashboard.
    case "correction_reviewed":
      return isLeave ? "/leave" : "/dashboard";
    case "shift_assigned":
      return "/schedule";
    case "trial_ending":
    case "trial_ended":
      // The activation code is entered on its own page.
      return viewer.isOwner ? "/activate" : "/dashboard";
    case "out_of_zone_employee":
      return "/dashboard";
  }
  // timesheet_ready/submitted/approved/rejected and timesheet_correction_*:
  // the Timesheets page (not the read-only report).
  if (type.startsWith("timesheet_")) return "/timesheets";
  if (type.startsWith("allowance_")) return "/allowances";
  return "/dashboard";
}
