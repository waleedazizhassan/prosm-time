import { useEffect, useRef } from "react";

// B-11: tapping the logo (or the dashboard button) while already on the dashboard reloads the
// dashboard's data in place - no page reload, no remount - so the person's filters, period,
// chosen site and layout stay exactly as they were. Each card that loads data listens.
const EVENT = "prosm:dashboard-refresh";

export function requestDashboardRefresh(): void {
  window.dispatchEvent(new Event(EVENT));
}

export function useDashboardRefresh(onRefresh: () => void): void {
  const latest = useRef(onRefresh);
  useEffect(() => {
    latest.current = onRefresh;
  });
  useEffect(() => {
    const handler = () => latest.current();
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);
}
