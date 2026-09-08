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
        return { title: t("shell:notifications.exceptionPendingReview.titleLeave"), body: t("shell:notifications.exceptionPendingReview.bodyLeave", { name, days: days ?? "?" }) };
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
  }

  return { title: notification.title, body: notification.body };
}
