import type { TFunction } from "i18next";
import type { AppNotification } from "../repositories/NotificationRepository";

// PROSM Time - § live UX review, user-directed: "notifications need to
// be translated - they're not translated in Arabic mode." Every
// notification's title/body was built as a literal English string at
// creation time in PL/pgSQL, with no localization path at all. The
// fix (20260903120000_localize_notifications.sql): every notification
// now also carries a structured `data` payload (employee name,
// distance, which sub-case a shared `type` represents, a manager's
// decision) - this renders a real localized sentence from `type` +
// `data` through i18n. A notification this function doesn't recognize
// (an older row from before this migration, or a future type this
// client doesn't know yet) falls back to its raw stored title/body -
// same graceful-degradation posture as humanizeBackendError.
export default function localizeNotification(notification: AppNotification, t: TFunction): { title: string; body: string | null } {
  const data = notification.data ?? {};

  switch (notification.type) {
    case "out_of_zone_employee": {
      const distance = typeof data.distanceMeters === "number" ? data.distanceMeters : null;
      if (distance === null) break;
      return { title: t("shell:notifications.outOfZoneEmployee.title"), body: t("shell:notifications.outOfZoneEmployee.body", { distance }) };
    }
    case "out_of_zone_manager": {
      const name = typeof data.employeeName === "string" ? data.employeeName : null;
      const distance = typeof data.distanceMeters === "number" ? data.distanceMeters : null;
      if (!name || distance === null) break;
      return { title: t("shell:notifications.outOfZoneManager.title"), body: t("shell:notifications.outOfZoneManager.body", { name, distance }) };
    }
    case "exception_pending_review": {
      const name = typeof data.employeeName === "string" ? data.employeeName : null;
      const kind = data.kind === "exception" || data.kind === "correction" || data.kind === "early_leave" || data.kind === "leave" ? data.kind : null;
      if (!name || !kind) break;
      if (kind === "leave") {
        const days = typeof data.days === "number" ? data.days : null;
        const leaveType = typeof data.leaveType === "string" ? data.leaveType : null;
        const startDate = typeof data.startDate === "string" ? data.startDate : null;
        const endDate = typeof data.endDate === "string" ? data.endDate : null;
        const reason = typeof data.reason === "string" ? data.reason : null;
        const typeLabel = leaveType ? t(`leave:types.${leaveType}`) : t("leave:types.other");
        const body =
          startDate && endDate
            ? t("shell:notifications.exceptionPendingReview.bodyLeaveDetailed", {
                name,
                days: days ?? "?",
                type: typeLabel,
                startDate,
                endDate,
              }) + (reason ? ` ${t("shell:notifications.exceptionPendingReview.bodyLeaveReasonSuffix", { reason })}` : "")
            : t("shell:notifications.exceptionPendingReview.bodyLeave", { name, days: days ?? "?" });
        return { title: t("shell:notifications.exceptionPendingReview.titleLeave"), body };
      }
      const titleKey =
        kind === "exception"
          ? "shell:notifications.exceptionPendingReview.titleException"
          : kind === "correction"
            ? "shell:notifications.exceptionPendingReview.titleCorrection"
            : "shell:notifications.exceptionPendingReview.titleEarlyLeave";
      const bodyKey =
        kind === "exception"
          ? "shell:notifications.exceptionPendingReview.bodyException"
          : kind === "correction"
            ? "shell:notifications.exceptionPendingReview.bodyCorrection"
            : "shell:notifications.exceptionPendingReview.bodyEarlyLeave";
      return { title: t(titleKey), body: t(bodyKey, { name }) };
    }
    case "correction_reviewed": {
      const kind = data.kind === "exception" || data.kind === "correction" || data.kind === "leave" ? data.kind : null;
      const actionType = typeof data.actionType === "string" ? data.actionType : null;
      if (!kind || !actionType) break;
      const decision = t(`shell:notifications.decision.${actionType}`, { defaultValue: actionType });
      const titleKey =
        kind === "exception"
          ? "shell:notifications.correctionReviewed.titleException"
          : kind === "correction"
            ? "shell:notifications.correctionReviewed.titleCorrection"
            : "shell:notifications.correctionReviewed.titleLeave";
      return {
        title: t(titleKey),
        body: t("shell:notifications.correctionReviewed.body", { decision }),
      };
    }
    case "break_exceeded":
      return { title: t("shell:notifications.breakExceeded.title"), body: t("shell:notifications.breakExceeded.body") };
    case "sos_alert": {
      const name = typeof data.employeeName === "string" ? data.employeeName : null;
      if (!name) break;
      return { title: t("shell:notifications.sosAlert.title"), body: t("shell:notifications.sosAlert.body", { name }) };
    }
    // § real bug, user-reported - "timesheet notifications aren't
    // translated." These 6 types (plus shift_assigned below) were never
    // handled here at all - every one of them fell straight through to
    // the raw stored (English-only) title/body. None of these need any
    // dynamic data - unlike out_of_zone/exception cases, "your timesheet
    // was approved" reads the same regardless of which timesheet.
    case "timesheet_submitted":
      return { title: t("shell:notifications.timesheet.submittedTitle"), body: t("shell:notifications.timesheet.submittedBody") };
    case "timesheet_approved":
      return { title: t("shell:notifications.timesheet.approvedTitle"), body: t("shell:notifications.timesheet.approvedBody") };
    case "timesheet_rejected":
      return { title: t("shell:notifications.timesheet.rejectedTitle"), body: t("shell:notifications.timesheet.rejectedBody") };
    case "timesheet_correction_requested":
      return { title: t("shell:notifications.timesheet.correctionRequestedTitle"), body: t("shell:notifications.timesheet.correctionRequestedBody") };
    case "timesheet_correction_approved":
      return { title: t("shell:notifications.timesheet.correctionApprovedTitle"), body: t("shell:notifications.timesheet.correctionApprovedBody") };
    case "timesheet_correction_rejected":
      return { title: t("shell:notifications.timesheet.correctionRejectedTitle"), body: t("shell:notifications.timesheet.correctionRejectedBody") };
    case "shift_assigned": {
      const shiftDate = typeof data.shiftDate === "string" ? data.shiftDate : null;
      if (!shiftDate) break;
      if (data.cancelled === true) {
        return { title: t("shell:notifications.shiftAssigned.cancelledTitle"), body: t("shell:notifications.shiftAssigned.cancelledBody", { date: shiftDate }) };
      }
      const startTime = typeof data.startTime === "string" ? data.startTime : "";
      const endTime = typeof data.endTime === "string" ? data.endTime : "";
      const body =
        data.crossesMidnight === true
          ? t("shell:notifications.shiftAssigned.bodyOvernight", { date: shiftDate, startTime, endTime })
          : t("shell:notifications.shiftAssigned.body", { date: shiftDate, startTime, endTime });
      return { title: t("shell:notifications.shiftAssigned.title"), body };
    }
    // § real gap fix, 14-point live-audit - site_change_events and
    // an abandoned/missing-checkout session both had zero alerting
    // before this pass; these two new types carry the same localized
    // treatment as every other notification kind.
    case "site_change_alert": {
      const name = typeof data.employeeName === "string" ? data.employeeName : null;
      if (!name) break;
      const oldSite = typeof data.oldSiteName === "string" ? data.oldSiteName : t("shell:notifications.siteChangeAlert.unregisteredLocation");
      const newSite = typeof data.newSiteName === "string" ? data.newSiteName : t("shell:notifications.siteChangeAlert.unregisteredLocation");
      return { title: t("shell:notifications.siteChangeAlert.title"), body: t("shell:notifications.siteChangeAlert.body", { name, oldSite, newSite }) };
    }
    case "missing_clock_out": {
      const name = typeof data.employeeName === "string" ? data.employeeName : null;
      const hours = typeof data.hoursSinceClockIn === "number" ? data.hoursSinceClockIn : null;
      if (!name || hours === null) break;
      return { title: t("shell:notifications.missingClockOut.title"), body: t("shell:notifications.missingClockOut.body", { name, hours }) };
    }
  }

  return { title: notification.title, body: notification.body };
}
