import { useCallback, useEffect, useState } from "react";

import DatabaseManager from "../database/DatabaseManager";

// Owner 2026-11-03: a plan's features are real. The server refuses what the plan does
// not include; this tells the screens what to show. Read once per sign-in and shared.
export const PLAN_FEATURES = [
  "leave",
  "allowances",
  "approvals",
  "kiosk",
  "on_behalf",
  "export",
  "payroll_export",
  "clock_rules",
  "scheduling",
  "roles_manager",
  "audit",
  "sos",
  "roles_all",
  "clock_suggestion",
  "labor_cost",
  "integrations",
  "daily_summary",
  "manager_alerts",
  // 2026-11-08: the payroll module (Pro and the organisations from before plans)
  "payroll",
  // 2026-11-10: four plans - the media centre (Business+), delegation and retention control (Enterprise)
  "announcements",
  "departments",
  "delegation",
  "retention",
  // 2026-11-11 HR suite: employee documents and the penalties bylaw (Business+)
  "documents",
  "penalties",
  // 2026-11-13 PROSM Connect (Business: chat, verified photo, calls, site message; Pro: push-to-talk, meetings,
  // screen sharing, meeting recording)
  "connect_chat",
  "connect_camera_photo",
  "connect_calls",
  "connect_site_broadcast",
  "connect_push_to_talk",
  "connect_meetings",
  "connect_screen_share",
  "connect_meeting_recording",
] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

export interface PlanFeatures {
  plan: string;
  status: string;
  /** Days of records shown and reported; null = all (migration 20261103170000). */
  historyDays: number | null;
  features: Partial<Record<PlanFeature, boolean>>;
}

let cached: Promise<PlanFeatures | null> | null = null;
let cachedFor: string | null = null;
let cachedAt = 0;
const MAX_AGE_MS = 5 * 60 * 1000;

function load(userKey: string): Promise<PlanFeatures | null> {
  if (cached && cachedFor === userKey && Date.now() - cachedAt < MAX_AGE_MS) return cached;
  cachedFor = userKey;
  cachedAt = Date.now();
  // no client (no connection settings, e.g. in tests): the plan is unknown and everything shows, as before it loads
  cached = new Promise<PlanFeatures | null>((resolve) => {
    try {
      Promise.resolve(DatabaseManager.getClient().rpc("get_prosm_time_plan_features"))
        .then(({ data, error }) => resolve(error ? null : (data as PlanFeatures)), () => resolve(null));
    } catch {
      resolve(null);
    }
  });
  return cached;
}

/** Forget the plan (after a code is redeemed or the licence changes). */
export function resetPlanFeatures() {
  cached = null;
  cachedFor = null;
}

/** Until the plan is known everything shows; the server still refuses what is outside it. */
export default function usePlanFeatures(userKey: string | null | undefined) {
  const [plan, setPlan] = useState<PlanFeatures | null>(null);
  useEffect(() => {
    if (!userKey) return undefined;
    let cancelled = false;
    void load(userKey).then((result) => {
      if (!cancelled) setPlan(result);
    });
    return () => {
      cancelled = true;
    };
  }, [userKey]);
  const allows = useCallback((feature: PlanFeature | undefined) => !feature || !plan || plan.features[feature] === true, [plan]);
  return { plan, allows };
}
