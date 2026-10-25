// v2.3.43 step 17: the dashboard's period (week Sunday to Saturday), the
// comparison only when a previous period exists, the saved widget order and
// the audit log's labels.
import { describe, expect, it } from "vitest";

import { auditLabel, DEFAULT_ORDER, mergeOrder, periodRange, trend } from "./dashboardLogic";

describe("dashboard logic", () => {
  it("the week runs Sunday to Saturday; the month is the whole month", () => {
    const wednesday = new Date(2026, 9, 28, 10);
    expect(periodRange("week", { from: "", to: "" }, wednesday)).toEqual({ from: "2026-10-25", to: "2026-10-31" });
    expect(periodRange("month", { from: "", to: "" }, wednesday)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(periodRange("day", { from: "", to: "" }, wednesday)).toEqual({ from: "2026-10-28", to: "2026-10-28" });
    expect(periodRange("custom", { from: "2026-09-01", to: "2026-09-10" }, wednesday)).toEqual({ from: "2026-09-01", to: "2026-09-10" });
    expect(periodRange("custom", { from: "2026-09-01", to: "" }, wednesday)).toEqual({ from: "2026-10-28", to: "2026-10-28" });
  });

  it("no comparison is invented without a previous period", () => {
    expect(trend(10, null)).toBeNull();
    expect(trend(10, 0)).toBeNull();
    expect(trend(12, 10)).toEqual({ change: 20, good: true });
    expect(trend(12, 10, true)).toEqual({ change: 20, good: false });
  });

  it("a saved order drops unknown widgets and gains new ones", () => {
    const merged = mergeOrder(["audit", "gone" as never, "map"]);
    expect(merged.slice(0, 2)).toEqual(["audit", "map"]);
    expect([...merged].sort()).toEqual([...DEFAULT_ORDER].sort());
  });

  it("audit actions get a named or a grouped label", () => {
    const t = (key: string) => key;
    expect(auditLabel("SOS_ALERT_RESOLVED", t)).toBe("manager.audit.named.SOS_ALERT_RESOLVED");
    expect(auditLabel("attendance.day_adjusted", t)).toBe("manager.audit.named.attendance_day_adjusted");
    expect(auditLabel("KIOSK_CLOCK_IN_OPERATED", t)).toBe("manager.audit.groups.attendance");
    expect(auditLabel("site.outside_zone_policy", t)).toBe("manager.audit.groups.sites");
    expect(auditLabel("XERO_DISCONNECTED", t)).toBe("manager.audit.groups.settings");
    expect(auditLabel("SOMETHING_NEW", t)).toBe("manager.audit.groups.other");
  });
});
