// Owner 2026-10-18/20: tapping a push notification opens the page it is about.
import { describe, expect, it } from "vitest";

import { isPushSupported, pushTarget } from "./PushService";

describe("push notifications", () => {
  it("opens the page the notification is about", () => {
    expect(pushTarget({ type: "sos_alert" })).toBe("/emergency-log");
    expect(pushTarget({ type: "exception_pending_review", entityType: "leave_requests" })).toBe("/leave");
    expect(pushTarget({ type: "timesheet_submitted" })).toBe("/timesheets");
    expect(pushTarget({ type: "out_of_zone_manager" })).toBe("/manager");
    expect(pushTarget({ type: "shift_assigned" })).toBe("/dashboard");
    expect(pushTarget(undefined)).toBe("/dashboard");
  });

  it("stays off outside an Android build made with Firebase", () => {
    expect(isPushSupported()).toBe(false);
  });
});
