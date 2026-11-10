import type { TFunction } from "i18next";
import { Capacitor } from "@capacitor/core";

import type { StateKind } from "./errorKind";
import BackgroundLocationService from "../services/BackgroundLocationService";

// Owner 2026-11-10: "the OK under a message should fix the problem when it can - take you where it is
// solved, or reload the page if that is what it needs". For each kind of problem, the one step that
// solves it (or nothing, and the message simply closes).
export interface ErrorFix {
  label: string;
  run: () => void;
}

const AUTH_PAGES = /^\/(login|forgot-password|reset-password|activate|welcome|accept-invitation)/;

export function errorFixFor(kind: StateKind, text: string, t: TFunction): ErrorFix | null {
  const path = typeof window !== "undefined" ? window.location.pathname : "/";
  const reload = () => window.location.reload();
  switch (kind) {
    case "offline":
      // the connection is back: try again; still offline: the page reloads when it returns
      return { label: t("common:feedback.fix.retry"), run: reload };
    case "server":
      return { label: t("common:feedback.fix.reload"), run: reload };
    case "session":
      if (AUTH_PAGES.test(path)) return null;
      return { label: t("common:feedback.fix.signIn"), run: () => window.location.assign("/login") };
    case "location":
    case "camera":
      if (Capacitor.isNativePlatform()) {
        return { label: t("common:feedback.fix.openSettings"), run: () => void BackgroundLocationService.openSettings() };
      }
      // in a browser the permission is asked again when the page loads
      return { label: t("common:feedback.fix.askAgain"), run: reload };
    case "notFound":
      return window.history.length > 1 ? { label: t("common:feedback.fix.back"), run: () => window.history.back() } : null;
    default:
      break;
  }
  // a feature outside the plan: the plan card says what is included (the owner can act on it)
  if (text === t("common:backendErrors.featureNotInPlan") && !path.startsWith("/settings")) {
    return { label: t("common:feedback.fix.seePlan"), run: () => window.location.assign("/settings#plan") };
  }
  return null;
}
