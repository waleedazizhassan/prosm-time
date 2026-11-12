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
  /** The related record's id (push: data.entityId; bell: relatedEntityId). */
  entityId?: unknown;
  /** The day a daily summary is about (the bell has it; a push tap opens yesterday). */
  date?: unknown;
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
    // Owner 2026-11-11: someone left their work area - the manager page says what became of it (still
    // waiting for the reason, waiting for review, or decided) instead of opening on nothing
    case "out_of_zone_manager":
      return ref?.entityId ? `/manager?exceptionId=${String(ref.entityId)}` : "/manager";
    case "exception_pending_review":
    case "correction_submitted":
    case "site_change_alert":
    case "location_plausibility_flag":
    case "missing_clock_out":
      return "/manager";
    // v2.3.43 step 2: the manager reviews an automatically closed shift on the
    // Manager Console; the employee answers "still working?" on the dashboard.
    case "session_auto_closed":
      return viewer.isOwner || ref?.kind === "manager" ? "/manager" : "/dashboard";
    case "long_session_check":
    case "overtime_soon":
    case "new_device_login":
    case "exit_site_prompt":
    case "clock_in_reminder":
    case "clock_out_reminder":
      return "/dashboard";
    case "auto_checkout_geofence":
      return ref?.kind === "manager" ? "/attendance?period=today" : "/dashboard";
    // The employee's exceptions card lives on the dashboard.
    case "correction_reviewed":
      return isLeave ? (viewer.isOwner ? "/leave" : "/me?tab=leave") : "/dashboard";
    case "shift_assigned":
      return "/schedule";
    // owner 2026-11-03: the morning summary opens the day it is about; a licence change, the plan card
    case "daily_digest":
      return viewer.isOwner ? (typeof ref?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(ref.date) ? `/daily-summary?date=${ref.date}` : "/daily-summary") : "/dashboard";
    case "owner_authority_granted":
    case "owner_authority_revoked":
      return "/dashboard";
    // owner 2026-11-08: payslip requests go to the requests list; the employee's to My payslips
    case "payslip_requested":
    case "payslip_send_failed":
      return "/payroll/requests";
    // 2026-11-11 HR suite feature 2: a document - personnel managers to the documents page, the person to
    // the documents in their own file (where the camera button is)
    // 2026-11-11 HR suite feature 1: deciding goes to the penalties page on that violation; the person to their file
    case "penalty_review":
    case "penalty_appeal":
      return ref?.entityId ? `/penalties?tab=action&open=${String(ref.entityId)}` : "/penalties";
    case "incentive_review":
      return "/penalties?tab=incentives";
    case "penalty_response":
    case "penalty_decided":
    case "penalty_appeal_decided":
    case "incentive_granted":
      return "/me?tab=penalties";
    case "document_uploaded":
    case "document_clock_in":
      return "/documents";
    case "document_missing":
    case "document_expiring":
    case "document_expired":
    case "document_rejected":
    case "document_reminder":
      return ref?.kind === "hr" || viewer.isOwner ? "/documents" : "/me?tab=documents";
    // Owner 2026-11-10: a Buzz opens the clock-in screen (where "clock in / out" is done)
    case "buzz":
      return "/clock-in";
    // 2026-11-09 Media Center: the employee's announcements
    case "announcement_published":
      return "/announcements";
    case "payslip_sent":
    case "payslip_published":
      return "/payslips";
    // B-10 (2026-11-08): the licence reminder opens the plan card too (it fell through to the dashboard)
    case "license_changed":
    case "license_ending":
      return viewer.isOwner ? "/settings#plan" : "/dashboard";
    // the employee's own break ran over: their dashboard
    case "break_exceeded":
      return "/dashboard";
    case "shift_no_show":
      return "/attendance?period=today";
    case "trial_ending":
    case "trial_ended":
      // The activation code is entered on its own page.
      return viewer.isOwner ? "/activate" : "/dashboard";
    case "out_of_zone_employee":
      return "/exceptions";
  }
  // timesheet_ready/submitted/approved/rejected and timesheet_correction_*:
  // the Timesheets page (not the read-only report).
  if (type.startsWith("timesheet_")) return "/timesheets";
  if (type.startsWith("allowance_")) return "/allowances";
  return "/dashboard";
}
