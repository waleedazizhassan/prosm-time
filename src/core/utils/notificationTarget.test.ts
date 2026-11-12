// Owner 2026-10-20: the bell and push notifications open the same page.
import { describe, expect, it } from "vitest";

import notificationTarget from "./notificationTarget";

const employee = { isOwner: false, canViewEmergencyLog: false };
const supervisor = { isOwner: false, canViewEmergencyLog: true };
const owner = { isOwner: true, canViewEmergencyLog: false };

describe("notificationTarget", () => {
  it("sends a penalty to decide to the penalties page on it, and the person's own to their file", () => {
    expect(notificationTarget({ type: "penalty_review", entityId: "v1" }, supervisor)).toBe("/penalties?tab=action&open=v1");
    expect(notificationTarget({ type: "penalty_appeal", entityId: "v2" }, owner)).toBe("/penalties?tab=action&open=v2");
    expect(notificationTarget({ type: "incentive_review" }, supervisor)).toBe("/penalties?tab=incentives");
    expect(notificationTarget({ type: "penalty_decided" }, employee)).toBe("/me?tab=penalties");
    expect(notificationTarget({ type: "incentive_granted" }, employee)).toBe("/me?tab=penalties");
  });

  it("sends a document to the person's own documents, or personnel managers to the documents page", () => {
    expect(notificationTarget({ type: "document_expiring", kind: "self" }, employee)).toBe("/me?tab=documents");
    expect(notificationTarget({ type: "document_rejected", kind: "self" }, employee)).toBe("/me?tab=documents");
    expect(notificationTarget({ type: "document_expiring", kind: "hr" }, supervisor)).toBe("/documents");
    expect(notificationTarget({ type: "document_uploaded", kind: "hr" }, supervisor)).toBe("/documents");
    expect(notificationTarget({ type: "document_missing" }, owner)).toBe("/documents");
  });

  it("opens the Emergency Log only for those who can see it", () => {
    expect(notificationTarget({ type: "sos_alert" }, supervisor)).toBe("/emergency-log");
    expect(notificationTarget({ type: "sos_alert" }, owner)).toBe("/emergency-log");
    expect(notificationTarget({ type: "sos_alert" }, employee)).toBe("/dashboard");
  });

  it("sends every review request to the Manager Console, leave included", () => {
    expect(notificationTarget({ type: "exception_pending_review", entityType: "leave_requests", kind: "leave" }, supervisor)).toBe("/manager");
    expect(notificationTarget({ type: "exception_pending_review", kind: "exception" }, supervisor)).toBe("/manager");
  });

  it("sends a reviewed leave request to the leave tab of My file (owner 2026-11-12) and other decisions to the dashboard", () => {
    expect(notificationTarget({ type: "correction_reviewed", kind: "leave" }, employee)).toBe("/me?tab=leave");
    expect(notificationTarget({ type: "correction_reviewed", entityType: "leave_requests" }, employee)).toBe("/me?tab=leave");
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
    expect(notificationTarget({ type: "out_of_zone_employee" }, employee)).toBe("/exceptions");
    expect(notificationTarget({ type: "trial_ending" }, owner)).toBe("/activate");
    expect(notificationTarget({ type: "allowance_rejected" }, supervisor)).toBe("/allowances");
    expect(notificationTarget({ type: "trial_ended" }, supervisor)).toBe("/dashboard");
    expect(notificationTarget({ type: "break_exceeded" }, employee)).toBe("/dashboard");
    expect(notificationTarget(undefined, employee)).toBe("/dashboard");
  });
  it("opens the daily summary of the day it is about, and the plan card for a licence change (owner 2026-11-03)", () => {
    expect(notificationTarget({ type: "daily_digest", date: "2026-11-02" }, owner)).toBe("/daily-summary?date=2026-11-02");
    expect(notificationTarget({ type: "daily_digest" }, owner)).toBe("/daily-summary");
    expect(notificationTarget({ type: "daily_digest", date: "x" }, owner)).toBe("/daily-summary");
    expect(notificationTarget({ type: "license_changed" }, owner)).toBe("/settings#plan");
    expect(notificationTarget({ type: "license_changed" }, employee)).toBe("/dashboard");
    expect(notificationTarget({ type: "license_ending" }, owner)).toBe("/settings#plan");
    expect(notificationTarget({ type: "break_exceeded" }, employee)).toBe("/dashboard");
  });
});
