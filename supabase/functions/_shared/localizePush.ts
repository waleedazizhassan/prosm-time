// A push notification's title and text in the phone's language, from the
// notification's type and data - the same rules and texts as the in-app
// bell (src/core/utils/localizeNotification.ts). Falls back to the stored
// (English) title/text for a type it doesn't know.
import { PUSH_TEXTS } from "./pushTexts.ts";

type Data = Record<string, unknown>;

function lookup(language: string, path: string): string | null {
  for (const lang of [language, "en"]) {
    let node: unknown = PUSH_TEXTS[lang]?.notifications;
    for (const part of path.split(".")) node = node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined;
    if (typeof node === "string") return node;
  }
  return null;
}

function fill(text: string, vars: Record<string, unknown>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => String(vars[key] ?? ""));
}

const str = (value: unknown) => (typeof value === "string" ? value : null);
const num = (value: unknown) => (typeof value === "number" ? value : null);

export function localizePush(type: string, data: Data, language: string, fallback: { title: string; body: string }): { title: string; body: string } {
  const t = (path: string, vars: Record<string, unknown> = {}) => {
    const text = lookup(language, path);
    return text === null ? null : fill(text, vars);
  };
  const pair = (titlePath: string, bodyPath: string, vars: Record<string, unknown> = {}) => {
    const title = t(titlePath, vars);
    const body = t(bodyPath, vars);
    return title && body !== null ? { title, body } : null;
  };

  // Owner 2026-10-20: the reviewer's note (data.notes, when sent) follows the decision.
  const notes = str(data.notes)?.trim() || null;
  const withNotes = (titlePath: string, bodyPath: string, vars: Record<string, unknown> = {}) => {
    const text = pair(titlePath, bodyPath, vars);
    const suffix = notes ? t("correctionReviewed.notesSuffix", { notes }) : null;
    return text && suffix ? { title: text.title, body: `${text.body} ${suffix}` } : text;
  };

  let result: { title: string; body: string } | null = null;
  switch (type) {
    case "out_of_zone_employee":
      if (num(data.distanceMeters) !== null) result = pair("outOfZoneEmployee.title", "outOfZoneEmployee.body", { distance: data.distanceMeters });
      break;
    case "out_of_zone_manager":
      if (str(data.employeeName) && num(data.distanceMeters) !== null)
        result = pair("outOfZoneManager.title", "outOfZoneManager.body", { name: data.employeeName, distance: data.distanceMeters });
      break;
    case "exception_pending_review": {
      const name = str(data.employeeName);
      const kind = str(data.kind);
      if (!name || !kind) break;
      if (kind === "leave") {
        const leaveType = str(data.leaveType);
        const typeLabel = (leaveType && PUSH_TEXTS[language]?.leaveTypes?.[leaveType]) ?? PUSH_TEXTS[language]?.leaveTypes?.other ?? "";
        const detailed = str(data.startDate) && str(data.endDate);
        const body = detailed
          ? t("exceptionPendingReview.bodyLeaveDetailed", { name, days: data.days ?? "?", type: typeLabel, startDate: data.startDate, endDate: data.endDate })
          : t("exceptionPendingReview.bodyLeave", { name, days: data.days ?? "?" });
        const title = t("exceptionPendingReview.titleLeave");
        if (title && body) result = { title, body };
        break;
      }
      // v2.3.43 step 6: an attendance permission asked by an employee (the kind's label is not in the push texts; the date is).
      // v2.3.59: a leave request withdrawn before anyone answered it.
      if (kind === "leave_request_withdrawn") {
        result = pair("exceptionPendingReview.titleLeaveRequestWithdrawn", "exceptionPendingReview.bodyLeaveRequestWithdrawn", { name, startDate: data.startDate ?? "", endDate: data.endDate ?? "" });
        break;
      }
      if (kind === "leave_cancelled") {
        result = pair("exceptionPendingReview.titleLeaveCancelled", "exceptionPendingReview.bodyLeaveCancelled", { name, startDate: data.startDate ?? "", endDate: data.endDate ?? "" });
        break;
      }
      if (kind === "permission") {
        result = pair("exceptionPendingReview.titlePermission", "exceptionPendingReview.bodyPermissionShort", { name, date: data.workDate ?? "" });
        break;
      }
      const suffix = kind === "exception" ? "Exception" : kind === "correction" ? "Correction" : kind === "early_leave" ? "EarlyLeave" : null;
      if (suffix) result = pair(`exceptionPendingReview.title${suffix}`, `exceptionPendingReview.body${suffix}`, { name });
      break;
    }
    case "correction_reviewed": {
      const kind = str(data.kind);
      const action = str(data.actionType);
      if (!kind || !action) break;
      const suffix = ({ exception: "Exception", correction: "Correction", leave: "Leave", mock_location: "MockLocation", offline_time: "OfflineTime", permission: "Permission", pending_hours: "PendingHours", integrity: "Integrity" } as Record<string, string>)[kind];
      const decision = t(`decision.${action}`) ?? action;
      if (suffix) result = withNotes(`correctionReviewed.title${suffix}`, "correctionReviewed.body", { decision });
      break;
    }
    case "break_exceeded":
      result = pair("breakExceeded.title", "breakExceeded.body");
      break;
    case "sos_alert":
      if (str(data.employeeName)) result = pair("sosAlert.title", "sosAlert.body", { name: data.employeeName });
      break;
    case "timesheet_ready":
      if (str(data.periodStart) && str(data.periodEnd))
        result = pair("timesheet.readyTitle", "timesheet.readyBody", { start: data.periodStart, end: data.periodEnd });
      break;
    case "timesheet_submitted":
      result = pair("timesheet.submittedTitle", "timesheet.submittedBody");
      break;
    case "timesheet_approved":
      result = withNotes("timesheet.approvedTitle", "timesheet.approvedBody");
      break;
    case "timesheet_rejected":
      result = withNotes("timesheet.rejectedTitle", "timesheet.rejectedBody");
      break;
    case "timesheet_correction_requested":
      result = pair("timesheet.correctionRequestedTitle", "timesheet.correctionRequestedBody");
      break;
    case "timesheet_correction_approved":
      result = withNotes("timesheet.correctionApprovedTitle", "timesheet.correctionApprovedBody");
      break;
    case "timesheet_correction_rejected":
      result = withNotes("timesheet.correctionRejectedTitle", "timesheet.correctionRejectedBody");
      break;
    case "allowance_submitted":
      if (str(data.employeeName) && str(data.periodStart) && str(data.periodEnd) && num(data.days) !== null)
        result = pair("allowance.submittedTitle", "allowance.sheetSubmittedBody", { name: data.employeeName, days: data.days, start: data.periodStart, end: data.periodEnd });
      else if (str(data.employeeName) && str(data.entryDate))
        result = pair("allowance.submittedTitle", "allowance.submittedBody", { name: data.employeeName, date: data.entryDate });
      break;
    case "allowance_approved":
      if (str(data.periodStart) && str(data.periodEnd)) result = withNotes("allowance.approvedTitle", "allowance.sheetApprovedBody", { start: data.periodStart, end: data.periodEnd });
      else if (str(data.entryDate)) result = withNotes("allowance.approvedTitle", "allowance.approvedBody", { date: data.entryDate });
      break;
    case "allowance_rejected":
      if (str(data.periodStart) && str(data.periodEnd)) result = withNotes("allowance.rejectedTitle", "allowance.sheetRejectedBody", { start: data.periodStart, end: data.periodEnd });
      else if (str(data.entryDate)) result = withNotes("allowance.rejectedTitle", "allowance.rejectedBody", { date: data.entryDate });
      break;
    case "trial_ending":
      result = pair("trial.endingTitle", "trial.endingBody");
      break;
    case "trial_ended":
      result = pair("trial.endedTitle", "trial.endedBody");
      break;
    case "correction_submitted":
      if (str(data.kind) === "account_deleted") result = pair("accountDeleted.title", "accountDeleted.body", { name: str(data.employeeName) ?? "" });
      break;
    case "license_ending":
      result = pair("trial.licenseEndingTitle", "trial.licenseEndingBody", { date: str(data.expiresAt)?.slice(0, 10) ?? "", license: str(data.licenseNumber) ?? "" });
      break;
    case "new_device_login": {
      const device = str(data.device) ?? "";
      const name = str(data.name);
      result = name ? pair("newDevice.title", "newDevice.ownerBody", { name, device }) : pair("newDevice.title", "newDevice.body", { device });
      break;
    }
    case "shift_assigned": {
      const date = str(data.shiftDate);
      if (!date) break;
      if (data.cancelled === true) result = pair("shiftAssigned.cancelledTitle", "shiftAssigned.cancelledBody", { date });
      else
        result = pair("shiftAssigned.title", data.crossesMidnight === true ? "shiftAssigned.bodyOvernight" : "shiftAssigned.body", {
          date,
          startTime: data.startTime ?? "",
          endTime: data.endTime ?? "",
        });
      break;
    }
    case "site_change_alert": {
      if (!str(data.employeeName)) break;
      const unregistered = t("siteChangeAlert.unregisteredLocation") ?? "";
      result = pair("siteChangeAlert.title", "siteChangeAlert.body", {
        name: data.employeeName,
        oldSite: str(data.oldSiteName) ?? unregistered,
        newSite: str(data.newSiteName) ?? unregistered,
      });
      break;
    }
    case "missing_clock_out":
      if (str(data.employeeName) && num(data.hoursSinceClockIn) !== null)
        result = pair("missingClockOut.title", "missingClockOut.body", { name: data.employeeName, hours: data.hoursSinceClockIn });
      break;
    case "long_session_check":
      if (num(data.hoursSinceClockIn) !== null) result = pair("longSessionCheck.title", "longSessionCheck.body", { hours: data.hoursSinceClockIn });
      break;
    case "session_auto_closed":
      if (num(data.maxHours) === null) break;
      result = str(data.employeeName)
        ? pair("sessionAutoClosed.titleManager", "sessionAutoClosed.bodyManager", { name: data.employeeName, hours: data.maxHours })
        : pair("sessionAutoClosed.titleEmployee", "sessionAutoClosed.bodyEmployee", { hours: data.maxHours });
      break;
    case "exit_site_prompt":
      result = pair("exitSitePrompt.title", "exitSitePrompt.body");
      break;
    // v2.3.48: the server's own clock-in/out reminders (they arrive with the app closed)
    case "shift_no_show":
      result = pair("noShow.title", "noShow.body", { name: data.name ?? "", time: data.time ?? "", site: data.siteName ?? "" });
      break;
    case "payslip_requested":
      result = pair("payslip.requestedTitle", "payslip.requestedBody", { name: data.employeeName ?? "", cycle: data.cycleTitle ?? "" });
      break;
    case "payslip_sent":
      result = data.channel === "app"
        ? pair("payslip.inAppTitle", "payslip.inAppBody", { cycle: data.cycleTitle ?? "" })
        : pair("payslip.sentTitle", "payslip.sentBody", { cycle: data.cycleTitle ?? "" });
      break;
    case "payslip_send_failed":
      result = pair("payslip.failedTitle", "payslip.failedBody", { cycle: data.cycleTitle ?? "" });
      break;
    // Owner 2026-11-10: a Buzz
    case "buzz": {
      const reason = ["clock_in", "clock_out", "call_me", "attention"].includes(String(data.reason)) ? String(data.reason) : "attention";
      const title = t("buzz.title", { name: data.fromName ?? "" });
      const body = str(data.message)?.trim() || t(`buzz.${reason}`);
      if (title && body) result = { title, body };
      break;
    }
    case "announcement_published":
      result = pair(data.kind === "statement" ? "announcement.statementTitle" : "announcement.publishedTitle", data.requiresAck ? "announcement.ackBody" : "announcement.publishedBody", { title: data.title ?? "" });
      break;
    case "payslip_published":
      result = pair("payslip.publishedTitle", "payslip.publishedBody");
      break;
    case "owner_authority_granted":
      result = pair("ownerAuthority.grantedTitle", "ownerAuthority.grantedBody");
      break;
    case "owner_authority_revoked":
      result = pair("ownerAuthority.revokedTitle", "ownerAuthority.revokedBody");
      break;
    case "overtime_soon":
      result = pair("overtimeSoon.title", "overtimeSoon.body", { name: data.name ?? "", time: data.time ?? "" });
      break;
    case "license_changed": {
      const unlimited = t("licenseChanged.unlimited") ?? "-";
      const value = (v: unknown) => (typeof v === "number" ? String(v) : unlimited);
      const parts: string[] = [];
      if (data.usersChanged) parts.push(t("licenseChanged.users", { from: value(data.usersFrom), to: value(data.usersTo) }) ?? "");
      if (data.devicesChanged) parts.push(t("licenseChanged.devices", { from: value(data.devicesFrom), to: value(data.devicesTo) }) ?? "");
      if (data.expiryChanged) parts.push(t("licenseChanged.ends", { date: typeof data.expiresAt === "string" ? data.expiresAt.slice(0, 10) : unlimited }) ?? "");
      if (data.statusChanged) parts.push(t("licenseChanged.status", { status: String(data.status ?? "") }) ?? "");
      if (data.planChanged) parts.push(typeof data.plan === "string" ? t("licenseChanged.planTo", { plan: data.plan.charAt(0).toUpperCase() + data.plan.slice(1) }) ?? "" : t("licenseChanged.plan") ?? "");
      result = pair("licenseChanged.title", "licenseChanged.body", { changes: parts.join(" · ") });
      break;
    }
    // 2026-11-11 HR suite feature 2: documents (same texts as the bell)
    case "document_missing":
    case "document_expiring":
    case "document_expired":
    case "document_rejected":
    case "document_reminder":
    case "document_uploaded":
    case "document_clock_in": {
      const key = ({ document_missing: "missing", document_expiring: "expiring", document_expired: "expired", document_rejected: "rejected", document_reminder: "reminder", document_uploaded: "uploaded", document_clock_in: "clockIn" } as Record<string, string>)[type];
      const who = data.kind === "hr" ? "Hr" : "Self";
      result = pair(`documents.${key}Title${who}`, `documents.${key}Body${who}`, { document: data.documentName ?? "", name: data.employeeName ?? "", count: num(data.days) ?? num(data.count) ?? 0, reason: data.reason ?? "" });
      break;
    }
    case "daily_digest":
      result = pair("dailyDigest.title", "dailyDigest.body", { present: data.present ?? 0, absent: data.absent ?? data.noShows ?? 0, late: data.late ?? 0, onLeave: data.onLeave ?? 0, leave: data.leave ?? 0, exceptions: data.exceptions ?? 0, open: data.open ?? 0 });
      if (result && (num(data.documentsExpired) ?? 0) + (num(data.documentsMissing) ?? 0) > 0) {
        const docs = t("dailyDigest.documents", { expired: num(data.documentsExpired) ?? 0, missing: num(data.documentsMissing) ?? 0 });
        if (docs) result = { title: result.title, body: `${result.body} ${docs}` };
      }
      break;
    case "clock_in_reminder":
      result = pair("clockInReminder.title", "clockInReminder.body", { time: data.time ?? "", site: data.siteName ?? "" });
      break;
    case "clock_out_reminder":
      result = pair("clockOutReminder.title", "clockOutReminder.body", { time: data.time ?? "" });
      break;
    case "auto_checkout_geofence":
      result = str(data.employeeName)
        ? pair("autoCheckoutGeofence.titleManager", "autoCheckoutGeofence.bodyManager", { name: data.employeeName })
        : pair("autoCheckoutGeofence.titleEmployee", "autoCheckoutGeofence.bodyEmployee");
      break;
    case "location_plausibility_flag":
      // owner 2026-11-11: a fake (simulated) location at clock-in/out or during the shift
      if (str(data.employeeName) && (data.kind === "mock_location" || data.kind === "mock_presence")) {
        const which = data.kind === "mock_presence" ? "presence" : data.eventType === "clock_out" ? "clock_out" : "clock_in";
        result = pair("mockLocation.title", `mockLocation.${which}`, { name: data.employeeName });
        break;
      }
      if (str(data.employeeName) && num(data.impliedSpeedKmh) !== null)
        result = pair("locationPlausibilityFlag.title", "locationPlausibilityFlag.body", { name: data.employeeName, speed: data.impliedSpeedKmh });
      break;
  }
  return result ?? fallback;
}
