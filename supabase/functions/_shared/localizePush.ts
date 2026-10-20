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
      const suffix = kind === "exception" ? "Exception" : kind === "correction" ? "Correction" : kind === "early_leave" ? "EarlyLeave" : null;
      if (suffix) result = pair(`exceptionPendingReview.title${suffix}`, `exceptionPendingReview.body${suffix}`, { name });
      break;
    }
    case "correction_reviewed": {
      const kind = str(data.kind);
      const action = str(data.actionType);
      if (!kind || !action) break;
      const suffix = kind === "exception" ? "Exception" : kind === "correction" ? "Correction" : kind === "leave" ? "Leave" : null;
      const decision = t(`decision.${action}`) ?? action;
      if (suffix) result = pair(`correctionReviewed.title${suffix}`, "correctionReviewed.body", { decision });
      break;
    }
    case "break_exceeded":
      result = pair("breakExceeded.title", "breakExceeded.body");
      break;
    case "sos_alert":
      if (str(data.employeeName)) result = pair("sosAlert.title", "sosAlert.body", { name: data.employeeName });
      break;
    case "timesheet_submitted":
      result = pair("timesheet.submittedTitle", "timesheet.submittedBody");
      break;
    case "timesheet_approved":
      result = pair("timesheet.approvedTitle", "timesheet.approvedBody");
      break;
    case "timesheet_rejected":
      result = pair("timesheet.rejectedTitle", "timesheet.rejectedBody");
      break;
    case "timesheet_correction_requested":
      result = pair("timesheet.correctionRequestedTitle", "timesheet.correctionRequestedBody");
      break;
    case "timesheet_correction_approved":
      result = pair("timesheet.correctionApprovedTitle", "timesheet.correctionApprovedBody");
      break;
    case "timesheet_correction_rejected":
      result = pair("timesheet.correctionRejectedTitle", "timesheet.correctionRejectedBody");
      break;
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
    case "location_plausibility_flag":
      if (str(data.employeeName) && num(data.impliedSpeedKmh) !== null)
        result = pair("locationPlausibilityFlag.title", "locationPlausibilityFlag.body", { name: data.employeeName, speed: data.impliedSpeedKmh });
      break;
  }
  return result ?? fallback;
}
