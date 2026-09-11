import type { TFunction } from "i18next";

// PROSM Time - § live UX review, user-directed: "a full error-message
// audit." Every backend RPC in this app raises its exceptions as
// literal ALL-CAPS English text (`raise exception 'YOU ARE ALREADY
// CLOCKED IN'`), and every repository's catch block relays that raw
// `error.message` straight to the UI whenever one exists - so a real,
// expected validation error (not a rare/unexpected failure) reaches
// the user as un-translated screaming-case English, in every
// language, instead of the same properly-translated sentence this
// codebase already uses for its "no message at all" fallback case.
//
// This is the fix: every raw message this backend can actually raise
// (enumerated directly from every `raise exception '...'` across
// supabase/migrations/*.sql - not guessed) maps to a translated
// common:backendErrors key. Call sites change from
// `result.message ?? t("ns.genericError")` to
// `humanizeBackendError(result.message, t) ?? t("ns.genericError")` -
// exactly one line at each site, and nothing else changes: an
// unmapped message (a genuinely unexpected failure, e.g. one of this
// backend's own `'X FAILED: %', sqlerrm` wrappers) still safely falls
// through to that same existing generic fallback, never raw text.
export default function humanizeBackendError(rawMessage: string | null | undefined, t: TFunction): string | null {
  if (!rawMessage) return null;
  const trimmed = rawMessage.trim();
  const key = BACKEND_ERROR_KEYS[trimmed];
  if (key) return t(`common:backendErrors.${key}`);
  // § 2026-09-08 real bug fix, defense in depth: the orphaned-
  // presence-session bug (admin_clock_out never closed it, now fixed
  // and self-healing) surfaced as this exact raw Postgres constraint
  // message, completely unmapped, showing the employee nothing but a
  // generic "unable to clock in" with zero explanation. Even though
  // the root cause is fixed, keep this mapped permanently - any other
  // future path that ever produces the same raw constraint violation
  // should still show something real, not silently fall through.
  if (trimmed.includes("presence_sessions_one_active_per_user")) {
    return t("common:backendErrors.orphanedPresenceSession");
  }
  return null;
}

// Raw backend message -> common:backendErrors.<key>. Keys use a
// single apostrophe (') for any raw message that contains one - SQL's
// own doubled '' escape (source: `raise exception 'USER''S DATA'`)
// resolves to one real apostrophe in the message the client receives.
const BACKEND_ERROR_KEYS: Record<string, string> = {
  "A BREAK IS ALREADY ACTIVE FOR THIS SESSION": "breakAlreadyActive",
  "A CORRECTION CAN ONLY BE REQUESTED ON A LOCKED (APPROVED) TIMESHEET": "correctionRequiresLockedTimesheet",
  "A REASON IS REQUIRED": "aReasonRequired",
  "A USER WITH THIS EMAIL ALREADY EXISTS IN THIS ORGANIZATION": "emailAlreadyExistsInOrganization",
  "A USER WITH THIS NAME ALREADY EXISTS IN THIS ORGANIZATION": "nameAlreadyExistsInOrganization",
  "ALLOWANCE ENTRY NOT FOUND": "allowanceEntryNotFound",
  "ALLOWANCES.APPROVE AUTHORITY REQUIRED FOR THIS EMPLOYEE": "allowancesApproveAuthorityRequired",
  "ATTENDANCE EVENT NOT FOUND": "attendanceEventNotFound",
  "ATTENDANCE IS NOT ALLOWED AT THIS SITE": "attendanceNotAllowedAtSite",
  "ATTENDANCE SESSION NOT FOUND": "attendanceSessionNotFound",
  "ATTENDANCE.CLOCK_IN_ON_BEHALF AUTHORITY REQUIRED": "clockInOnBehalfAuthorityRequired",
  "ATTENDANCE.CLOCK_OUT_ON_BEHALF AUTHORITY REQUIRED": "clockOutOnBehalfAuthorityRequired",
  "AUTH USER ID IS REQUIRED": "authUserIdRequired",
  "BREAK NOT FOUND": "breakNotFound",
  // Deliberately NOT mapped: CLOCK_IN_BLOCKED_CONTACT_MANAGER already
  // gets its own dedicated, richer copy at its one call site
  // (ClockInOutCard.tsx, dashboard.json's own clockInBlockedContactManager
  // key) - better than a generic fallback here.
  "CORRECTION REQUEST NOT FOUND": "correctionRequestNotFound",
  "DEVICE BINDING NOT FOUND": "deviceBindingNotFound",
  "EMPLOYEE NOT FOUND": "employeeNotFound",
  "EMPLOYEES.MANAGE_ACCOUNTS AUTHORITY REQUIRED": "employeesManageAccountsAuthorityRequired",
  "ENTRY DATE IS REQUIRED": "entryDateRequired",
  "EXCEPTION NOT FOUND": "exceptionNotFound",
  "EXCEPTIONS.MANAGE AUTHORITY REQUIRED": "exceptionsManageAuthorityRequired",
  "IDEMPOTENCY KEY IS REQUIRED": "idempotencyKeyRequired",
  "INCORRECT PIN": "incorrectPin",
  "INSUFFICIENT AUTHORITY TO VIEW ANOTHER USER'S PERMISSIONS": "insufficientAuthorityViewPermissions",
  "INVALID ACTION": "invalidAction",
  "INVALID ACTION TYPE": "invalidActionType",
  "INVALID BREAK ROUNDING MODE": "invalidBreakRoundingMode",
  "INVALID DEVICE BINDING STATUS": "invalidDeviceBindingStatus",
  "INVALID KIND": "invalidKind",
  "INVALID LICENSE STATUS": "invalidLicenseStatus",
  "INVALID PROPOSED EVENT TYPE": "invalidProposedEventType",
  "INVALID REASON CATEGORY": "invalidReasonCategory",
  "INVALID ROLE AT SITE": "invalidRoleAtSite",
  "INVALID ROLE FOR AN INVITED USER": "invalidRoleForInvitedUser",
  "INVALID VERIFICATION CODE": "invalidVerificationCode",
  "KIOSK MODE IS NOT ENABLED FOR THIS SITE": "kioskModeNotEnabled",
  "LATITUDE AND LONGITUDE ARE REQUIRED": "latitudeLongitudeRequired",
  "LICENSE NUMBER IS REQUIRED": "licenseNumberRequired",
  "NO ACCOUNT FOUND FOR THIS EMAIL": "noAccountFoundForEmail",
  "NO AUTHENTICATED SESSION": "noAuthenticatedSession",
  "NO LICENSE ACTIVATION STATE FOUND FOR THIS ORGANIZATION": "noLicenseActivationState",
  "NO ORGANIZATION FOR THIS SESSION": "noOrganizationForSession",
  "NO PENDING INVITATION FOUND FOR THIS EMAIL": "noPendingInvitationForEmail",
  "NO PENDING PASSWORD RESET REQUEST FOUND FOR THIS EMAIL": "noPendingPasswordResetForEmail",
  "ONLY THE ORGANIZATION OWNER MAY ASSIGN NON-EMPLOYEE MEMBERS TO A SITE": "ownerOnlyAssignNonEmployeeToSite",
  "ONLY THE ORGANIZATION OWNER MAY CREATE A NEW SITE": "ownerOnlyCreateSite",
  "ONLY THE ORGANIZATION OWNER MAY GRANT SITE MANAGER": "ownerOnlyGrantSiteManager",
  "ONLY THE ORGANIZATION OWNER MAY SET THE LOGO": "ownerOnlySetLogo",
  "ONLY THE ORGANIZATION OWNER MAY SET THE NO-SITE RADIUS": "ownerOnlySetNoSiteRadius",
  "ORGANIZATION NAME IS REQUIRED": "organizationNameRequired",
  "OWNER EMAIL IS REQUIRED": "ownerEmailRequired",
  "OWNER ROLE NOT FOUND - ROLE CATALOG NOT SEEDED": "ownerRoleNotFound",
  "PERIOD END MUST NOT BE BEFORE PERIOD START": "periodEndBeforeStart",
  "PERMISSIONS.ASSIGN AUTHORITY REQUIRED": "permissionsAssignAuthorityRequired",
  "PIN MUST BE 4 TO 6 DIGITS": "pinMustBe4To6Digits",
  "PRESENCE SESSION NOT FOUND": "presenceSessionNotFound",
  "PROJECT NAME IS REQUIRED": "projectNameRequired",
  "PROJECT NOT FOUND": "projectNotFound",
  "PROJECT NOT FOUND AT THIS SITE": "projectNotFoundAtSite",
  "PROJECTS.MANAGE AUTHORITY REQUIRED": "projectsManageAuthorityRequired",
  "PROPOSED CORRECT TIME IS NOT VALID FOR THIS SESSION": "proposedCorrectTimeNotValid",
  "PROPOSED CORRECT TIME IS REQUIRED": "proposedCorrectTimeRequired",
  "RADIUS MUST BE GREATER THAN ZERO": "radiusMustBeGreaterThanZero",
  "REASON IS REQUIRED": "reasonIsRequired",
  "RETENTION HOLD: THIS EMPLOYEE HAS A SUBMITTED, APPROVED, OR PREVIOUSLY-APPROVED TIMESHEET": "retentionHoldTimesheetExists",
  "ROLE NOT FOUND": "roleNotFound",
  "SITE NAME IS REQUIRED": "siteNameRequired",
  "SITE NOT FOUND": "siteNotFound",
  "SITES.MANAGE AUTHORITY REQUIRED": "sitesManageAuthorityRequired",
  "SITES.MANAGE AUTHORITY REQUIRED FOR THIS SITE": "sitesManageAuthorityRequiredForSite",
  "SOS ALERT NOT FOUND": "sosAlertNotFound",
  "SOS REQUIRES AN ACTIVE PRESENCE SESSION": "sosRequiresActivePresenceSession",
  "STORAGE PATH IS REQUIRED": "storagePathRequired",
  "THE OWNER'S AUTHORITY CANNOT BE OVERRIDDEN": "ownerAuthorityCannotBeOverridden",
  "THIS ALLOWANCE ENTRY HAS ALREADY BEEN SUBMITTED - EDITING IS ONLY ALLOWED WHILE IN DRAFT": "allowanceEntryAlreadySubmitted",
  "THIS ALLOWANCE ENTRY IS NOT AWAITING APPROVAL": "allowanceEntryNotAwaitingApproval",
  "THIS ALLOWANCE ENTRY IS NOT IN DRAFT STATUS": "allowanceEntryNotInDraft",
  "THIS BREAK IS ALREADY ENDED": "breakAlreadyEnded",
  "THIS CORRECTION REQUEST HAS ALREADY BEEN REVIEWED": "correctionRequestAlreadyReviewed",
  "THIS EMPLOYEE HAS NOT SET UP A KIOSK PIN": "employeeNoKioskPin",
  "THIS EMPLOYEE IS ALREADY CLOCKED IN": "employeeAlreadyClockedIn",
  "THIS EMPLOYEE IS CLOCKED IN AT A DIFFERENT SITE": "employeeClockedInDifferentSite",
  "THIS EMPLOYEE IS CURRENTLY CLOCKED IN": "employeeCurrentlyClockedIn",
  "THIS EMPLOYEE IS NOT ASSIGNED TO THIS PROJECT": "employeeNotAssignedToProject",
  "THIS EMPLOYEE IS NOT ASSIGNED TO THIS SITE": "employeeNotAssignedToSite",
  "THIS EMPLOYEE IS NOT CURRENTLY CLOCKED IN": "employeeNotCurrentlyClockedIn",
  "THIS EXCEPTION ALREADY HAS A REASON": "exceptionAlreadyHasReason",
  "THIS INVITATION HAS ALREADY BEEN USED": "invitationAlreadyUsed",
  "THIS INVITATION HAS EXPIRED": "invitationExpired",
  "THIS PRESENCE SESSION IS ALREADY ENDED": "presenceSessionAlreadyEnded",
  "THIS PRESENCE SESSION IS NOT ACTIVE": "presenceSessionNotActive",
  "THIS RESET CODE HAS EXPIRED": "resetCodeExpired",
  "THIS SOS ALERT IS ALREADY RESOLVED": "sosAlertAlreadyResolved",
  "THIS STORAGE PATH IS ALREADY LINKED TO EVIDENCE": "storagePathAlreadyLinked",
  "THIS TIMESHEET HAS ALREADY BEEN SUBMITTED - REGENERATION IS ONLY ALLOWED WHILE IN DRAFT": "timesheetAlreadySubmitted",
  "THIS TIMESHEET IS NOT AWAITING APPROVAL": "timesheetNotAwaitingApproval",
  "THIS TIMESHEET IS NOT IN DRAFT STATUS": "timesheetNotInDraft",
  "TIMESHEET NOT FOUND": "timesheetNotFound",
  "UNKNOWN PERMISSION KEY": "unknownPermissionKey",
  "USER NOT FOUND": "userNotFound",
  "WORKPLACE NAME IS REQUIRED WHEN NO SITE IS SELECTED": "workplaceNameRequiredWhenNoSite",
  "YOU ARE ALREADY AT THIS SITE": "youAreAlreadyAtThisSite",
  "YOU ARE ALREADY WORKING WITHOUT A REGISTERED SITE": "alreadyWorkingWithoutSite",
  "A REAL LOCATION SAMPLE IS REQUIRED TO CHANGE TO NO SITE": "locationSampleRequiredForNoSiteChange",
  "YOU ARE ALREADY CLOCKED IN": "youAreAlreadyClockedIn",
  "YOU ARE ON APPROVED LEAVE TODAY": "youAreOnApprovedLeaveToday",
  "YOU ARE NOT ASSIGNED TO THIS PROJECT": "youAreNotAssignedToProject",
  "YOU ARE NOT ASSIGNED TO THIS SITE": "youAreNotAssignedToSite",
  "YOU ARE NOT AUTHORIZED TO APPROVE THIS TIMESHEET": "notAuthorizedApproveTimesheet",
  "YOU ARE NOT AUTHORIZED TO ATTACH EVIDENCE TO THIS EVENT": "notAuthorizedAttachEvidence",
  "YOU ARE NOT AUTHORIZED TO DELETE THIS EMPLOYEE'S DATA": "notAuthorizedDeleteEmployeeData",
  "YOU ARE NOT AUTHORIZED TO EXPORT THIS EMPLOYEE'S DATA": "notAuthorizedExportEmployeeData",
  "YOU ARE NOT AUTHORIZED TO GENERATE A TIMESHEET FOR THIS EMPLOYEE": "notAuthorizedGenerateTimesheet",
  "YOU ARE NOT AUTHORIZED TO REVIEW THIS CORRECTION REQUEST": "notAuthorizedReviewCorrection",
  "YOU ARE NOT AUTHORIZED TO SET THIS EMPLOYEE'S KIOSK PIN": "notAuthorizedSetKioskPin",
  "YOU ARE NOT AUTHORIZED TO VIEW THIS EMPLOYEE'S OVERTIME": "notAuthorizedViewOvertime",
  "YOU ARE NOT AUTHORIZED TO VIEW THIS TIMESHEET": "notAuthorizedViewTimesheet",
  "YOU ARE NOT AUTHORIZED TO VIEW THIS TIMESHEET REPORT": "notAuthorizedViewTimesheetReport",
  "YOU ARE NOT CURRENTLY CLOCKED IN": "youAreNotCurrentlyClockedIn",
  "YOU ARE NOT THE SUBJECT OF THIS PRESENCE SESSION": "notSubjectOfPresenceSession",
  "YOU DO NOT MANAGE THIS EMPLOYEES SITE": "notManageEmployeesSite",
  "YOU DO NOT MANAGE THIS SITE": "notManageThisSite",
  "YOU MAY ONLY REQUEST A CORRECTION ON YOUR OWN TIMESHEET": "onlyRequestCorrectionOwnTimesheet",
  "YOU MAY ONLY SUBMIT YOUR OWN ALLOWANCE ENTRY": "onlySubmitOwnAllowanceEntry",
  "YOU MAY ONLY SUBMIT YOUR OWN TIMESHEET": "onlySubmitOwnTimesheet",
  "YOU MUST BE CLOCKED IN TO CHANGE SITE": "mustBeClockedInToChangeSite",
  "YOU MUST BE CLOCKED IN TO START A BREAK": "mustBeClockedInToStartBreak",
  "END TIME MUST BE DIFFERENT FROM START TIME": "shiftEndEqualsStart",
  "THIS EMPLOYEE ALREADY HAS AN OVERLAPPING SHIFT ON THIS DATE": "shiftOverlap",
};
