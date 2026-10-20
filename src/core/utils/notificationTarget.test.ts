// Owner 2026-10-20: the bell and push notifications open the same page.
import { describe, expect, it } from "vitest";

import notificationTarget from "./notificationTarget";

const employee = { isOwner: false, canViewEmergencyLog: false };
const supervisor = { isOwner: false, canViewEmergencyLog: true };
const owner = { isOwner: true, canViewEmergencyLog: false };

describe("notificationTarget", () => {
  it("opens the Emergency Log only for those who can see it", () => {
    expect(notificationTarget({ type: "sos_alert" }, supervisor)).toBe("/emergency-log");
    expect(notificationTarget({ type: "sos_alert" }, owner)).toBe("/emergency-log");
    expect(notificationTarget({ type: "sos_alert" }, employee)).toBe("/dashboard");
  });

  it("sends every review request to the Manager Console, leave included", () => {
    expect(notificationTarget({ type: "exception_pending_review", entityType: "leave_requests", kind: "leave" }, supervisor)).toBe("/manager");
    expect(notificationTarget({ type: "exception_pending_review", kind: "exception" }, supervisor)).toBe("/manager");
  });

  it("sends a reviewed leave request to Leave and other decisions to the dashboard", () => {
    expect(notificationTarget({ type: "correction_reviewed", kind: "leave" }, employee)).toBe("/leave");
    expect(notificationTarget({ type: "correction_reviewed", entityType: "leave_requests" }, employee)).toBe("/leave");
    expect(notificationTarget({ type: "correction_reviewed", kind: "mock_location" }, employee)).toBe("/dashboard");
  });

  it("opens the Timesheets page for every timesheet notification", () => {
    for (const type of [
      "timesheet_ready",
      "timesheet_submitted",
      "timesheet_approved",
      "timesheet_rejected",
      "timesheet_correction_requested",
      "timesheet_correction_approved",
      "timesheet_correction_rejected",
    ]) {
      expect(notificationTarget({ type, entityType: "timesheets" }, employee)).toBe("/timesheets");
    }
  });

  it("routes the remaining types", () => {
    expect(notificationTarget({ type: "shift_assigned" }, employee)).toBe("/schedule");
    for (const type of ["site_change_alert", "location_plausibility_flag", "out_of_zone_manager", "missing_clock_out"]) {
      expect(notificationTarget({ type }, supervisor)).toBe("/manager");
    }
    expect(notificationTarget({ type: "out_of_zone_employee" }, employee)).toBe("/dashboard");
    expect(notificationTarget({ type: "trial_ending" }, owner)).toBe("/settings");
    expect(notificationTarget({ type: "trial_ended" }, supervisor)).toBe("/dashboard");
    expect(notificationTarget({ type: "break_exceeded" }, employee)).toBe("/dashboard");
    expect(notificationTarget(undefined, employee)).toBe("/dashboard");
  });
});
