import type { TFunction } from "i18next";

import { classifyBackendError, rememberErrorKind } from "./errorKind";

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
  const text = translate(rawMessage.trim(), t);
  // v2.3.43 step 21: the kind of problem goes with the text, for its picture.
  if (text) rememberErrorKind(text, classifyBackendError(unwrap(rawMessage.trim())));
  return text;
}

function translate(trimmed: string, t: TFunction): string | null {
  const key = BACKEND_ERROR_KEYS[trimmed] ?? BACKEND_ERROR_KEYS[unwrap(trimmed)];
  if (key) return t(`common:backendErrors.${key}`);
  // v2.3.43 step 7: refusals that carry a number (a leave type's limits).
  for (const [pattern, patternKey] of NUMBERED_ERRORS) {
    const match = pattern.exec(unwrap(trimmed));
    if (match) return t(`common:backendErrors.${patternKey}`, { count: Number(match[1]) });
  }
  // § 2026-09-08 real bug fix, defense in depth: the orphaned-
  // presence-session bug (admin_clock_out never closed it, now fixed
  // and self-healing) surfaced as this exact raw Postgres constraint
  // message, completely unmapped, showing the employee nothing but a
  // generic "unable to clock in" with zero explanation. Even though
  // the root cause is fixed, keep this mapped permanently - any other
  // future path that ever produces the same raw constraint violation
  // should still show something real, not silently fall through.
  // Owner 2026-10-13 - a request that never reached the server (no
  // internet, weak signal, server unreachable) gets a kind message
  // instead of the browser's own technical text.
  if (/failed to fetch|networkerror|network request failed|load failed|fetch failed|failed to send a request|err_internet_disconnected|timed? ?out/i.test(trimmed)) {
    return t("common:backendErrors.networkProblem");
  }
  if (trimmed.includes("presence_sessions_one_active_per_user")) {
    return t("common:backendErrors.orphanedPresenceSession");
  }
  return null;
}

const NUMBERED_ERRORS: [RegExp, string][] = [
  [/^THIS LEAVE TYPE ALLOWS AT MOST ([\d.]+) DAYS AT A TIME$/, "leaveMaxDaysPerRequest"],
  [/^THIS LEAVE TYPE NEEDS ([\d.]+) YEARS OF SERVICE$/, "leaveMinServiceYears"],
  [/^THIS LEAVE TYPE CAN BE TAKEN AT MOST ([\d.]+) TIMES IN THE SERVICE$/, "leaveMaxTimesInService"],
];

// Raw backend message -> common:backendErrors.<key>. Keys use a
// single apostrophe (') for any raw message that contains one - SQL's
// own doubled '' escape (source: `raise exception 'USER''S DATA'`)
// resolves to one real apostrophe in the message the client receives.
// Audit 4.1 (2026-10-13) - most RPCs re-raise their own expected errors
// inside a 'X FAILED: %' wrapper ("KIOSK CLOCK IN FAILED: INCORRECT PIN"),
// so the exact-match lookup above missed them and a wrong kiosk PIN
// showed only "Unable to complete this action." The wrapper(s) are
// removed and the inner message is looked up; a genuinely unexpected
// inner message still falls through to the generic text.
function unwrap(message: string): string {
  let inner = message;
  for (let match = /^[A-Z][A-Z _]* FAILED: (.+)$/s.exec(inner); match; match = /^[A-Z][A-Z _]* FAILED: (.+)$/s.exec(inner)) {
    inner = match[1].trim();
  }
  return inner;
}

const BACKEND_ERROR_KEYS: Record<string, string> = {
  "THIS WORKER HAS ATTENDANCE - STOP THEM INSTEAD": "workerHasAttendance",
  "YOU HAVE ATTENDANCE RECORDED DURING THESE DATES - RESOLVE THE ATTENDANCE RECORD BEFORE REQUESTING LEAVE FOR THIS PERIOD": "leaveRequestOverlapsAttendance",
  "THIS EMPLOYEE HAS ATTENDANCE RECORDED DURING THIS LEAVE PERIOD - RESOLVE THE ATTENDANCE RECORD BEFORE APPROVING": "leaveOverlapsAttendance",
  "THIS ALLOWANCE SHEET IS NOT AWAITING APPROVAL": "sheetNotWaiting",
  "REVIEW THE WHOLE ALLOWANCE SHEET": "reviewWholeSheet",
  "NO ALLOWANCES TO SEND": "noAllowancesToSend",
  "THE OWNER HAS NO ALLOWANCES": "ownerHasNoAllowances",
  // Owner 2026-10-20: the server's newer refusals, in the reader's language.
  "A CATEGORY NEEDS A NAME": "categoryNeedsName",
  "A CATEGORY WITH THIS NAME ALREADY EXISTS": "categoryNameTaken",
  "A PRICE CANNOT BE NEGATIVE": "priceNegative",
  "AN ALLOWANCE CANNOT BE NEGATIVE": "allowanceNegative",
  "ALLOWANCES.APPROVE AUTHORITY REQUIRED": "allowancesApproveAuthorityRequired",
  "ATTENDANCE.VIEW AUTHORITY REQUIRED": "attendanceViewRequired",
  "CATEGORY NOT FOUND": "categoryNotFound",
  "CHOOSE A CATEGORY OR A PERSON, NOT BOTH": "categoryOrPerson",
  "CHOOSE A PERIOD OF UP TO TWO MONTHS": "periodUpToTwoMonths",
  "CHOOSE A SITE, A CATEGORY OR A PERSON": "chooseScope",
  "ONLY THE OWNER MAY DELETE A CATEGORY": "ownerDeletesCategory",
  "ONLY THE OWNER OR A MANAGER OF THIS SITE MAY OPERATE ITS KIOSK": "kioskOperator",
  "ONLY THE OWNER SETS PRICES FOR EVERY SITE - CHOOSE A SITE YOU MANAGE": "ownerSetsEverySite",
  "THE LOGO MUST BE AN UPLOADED IMAGE": "logoMustBeUploaded",
  "THE PHOTO MUST BE IN ITS OWN CLOCK-IN FOLDER": "photoOwnFolder",
  "THE PICTURE MUST BE AN UPLOADED IMAGE": "pictureMustBeUploaded",
  "THIS EMPLOYEE IS ON APPROVED LEAVE ON THIS DATE": "employeeOnLeaveThatDate",
  "YOU ARE NOT AUTHORIZED TO ASSIGN SHIFTS": "notAuthorizedAssignShifts",
  "YOU CAN ONLY MANAGE DEVICES OF PEOPLE BELOW YOUR ROLE AT SITES YOU MANAGE": "devicesBelowYou",
  "YOU CAN ONLY PRICE PEOPLE BELOW YOUR ROLE AT SITES YOU MANAGE": "priceBelowYou",
  "YOU CAN ONLY REMOVE PEOPLE BELOW YOUR ROLE FROM A SITE YOU MANAGE": "removeBelowYou",
  "YOU CAN ONLY SCHEDULE PEOPLE BELOW YOUR ROLE": "scheduleBelowYou",
  "YOU CAN ONLY SET THE CATEGORY OF PEOPLE BELOW YOUR ROLE AT SITES YOU MANAGE": "categoryBelowYou",
  "YOU CAN ONLY SET THE PIN OF PEOPLE BELOW YOUR ROLE AT SITES YOU MANAGE": "pinBelowYou",
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
  // Kiosk workforce keypad and attempt limit (audit 4.1).
  "NO ACTIVE WORKER WITH THIS NUMBER AT THIS SITE": "workerNumberNotRegistered",
  "NO WORKER WITH THIS NUMBER": "workerNumberNotRegistered",
  "ONLY THE OWNER OR THE SITES MANAGER MAY RUN THE WORKERS KIOSK": "workerKioskOwnerOrManager",
  "A NAME IS REQUIRED": "nameRequired",
  "NO FREE WORKER NUMBER - PLEASE TRY AGAIN": "noFreeWorkerNumber",
  "THIS WORKER IS NOT ACTIVE": "workerNotActive",
  "THIS WORKER IS ALREADY CLOCKED IN": "workerAlreadyClockedIn",
  "THIS WORKER IS NOT CURRENTLY CLOCKED IN": "workerNotClockedIn",
  "A REAL GPS SAMPLE IS REQUIRED": "realGpsSampleRequired",
  "Too many attempts. Please wait a few minutes and try again.": "tooManyAttempts",
  "YOU CAN ONLY ACT ON BEHALF OF PEOPLE BELOW YOUR ROLE": "onBehalfOnlyBelowRole",
  "ONLY THE OWNER OR A MANAGER MAY ACT ON SOMEONE ELSES BEHALF": "onBehalfOwnerOrManagerOnly",
  "A FAKE LOCATION IS NOT ACCEPTED": "fakeLocationRejected",
  "CLOCK_IN_OUTSIDE_AREA_CONTACT_MANAGER": "clockInOutsideAreaContactManager",
  "THIS ALLOWANCE ENTRY IS ALREADY APPROVED": "allowanceAlreadyApproved",
  "THE OWNER DOES NOT CLOCK IN OR OUT": "ownerDoesNotClockIn",
  "A MANAGER MAY ONLY CHANGE THE PERMISSIONS OF SUPERVISORS AT THEIR SITES": "delegationSupervisorsOnly",
  "A MANAGER MAY ONLY PASS ON PERMISSIONS THEY HOLD": "delegationOwnPermissionsOnly",
  "THIS PERMISSION IS FOR MANAGERS ONLY": "permissionForManagersOnly",
  // Offline replays (audit 1.4).
  "OFFLINE TIME IS BEFORE YOUR LAST RECORDED ACTION": "offlineTimeBeforeLastAction",
  "OFFLINE TIME FALLS ON A DAY OF APPROVED LEAVE": "offlineTimeOnLeaveDay",
  // v2.3.43 steps 1-2: out-of-zone policy, open shifts and pending hours.
  "INVALID OUTSIDE ZONE POLICY": "invalidOutsideZonePolicy",
  "SESSIONS.REVIEW_PENDING AUTHORITY REQUIRED": "sessionsReviewPendingRequired",
  "YOU CANNOT REVIEW YOUR OWN SHIFT": "cannotReviewOwnShift",
  "THIS SHIFT IS NOT WAITING FOR REVIEW": "shiftNotPendingReview",
  "INVALID CLOCK OUT TIME": "invalidClockOutTime",
  "THE TIMESHEET FOR THIS PERIOD IS ALREADY APPROVED": "timesheetPeriodApproved",
  "SETTINGS.SESSION_POLICY AUTHORITY REQUIRED": "sessionPolicyRequired",
  "INVALID OPEN SHIFT HOURS": "invalidOpenShiftHours",
  "THIS SHIFT IS NOT OPEN": "shiftNotOpen",
  "INVALID EXTENSION TIME": "invalidExtensionTime",
  // v2.3.43 step 3: the work calendar.
  "CALENDAR.MANAGE AUTHORITY REQUIRED": "calendarManageRequired",
  "ONLY THE OWNER CHANGES THE ORGANISATION-WIDE CALENDAR": "calendarOrgOwnerOnly",
  "INVALID HOLIDAY DATES": "invalidHolidayDates",
  "INVALID EXCEPTION DATES": "invalidExceptionDates",
  "INVALID WEEKDAYS": "invalidWeekdays",
  "CHOOSE ONE SCOPE": "chooseOneScope",
  "HOLIDAY NOT FOUND": "holidayNotFound",
  "SCHEDULE EXCEPTION NOT FOUND": "scheduleExceptionNotFound",
  "CHOOSE A PERIOD OF UP TO A YEAR": "periodUpToYear",
  // v2.3.43 step 4: allowance calculation basis.
  "ONLY THE OWNER SETS HOW AN ALLOWANCE IS CALCULATED": "basisOwnerOnly",
  "INVALID ALLOWANCE": "invalidAllowance",
  "INVALID CALCULATION BASIS": "invalidCalculationBasis",
  // v2.3.43 step 5: editing allowances during review, reopening.
  "ALLOWANCES.EDIT_DURING_REVIEW AUTHORITY REQUIRED": "allowancesEditInReviewRequired",
  "YOU CANNOT EDIT YOUR OWN ALLOWANCES IN REVIEW": "cannotEditOwnAllowances",
  "THIS ALLOWANCE ENTRY IS NOT IN REVIEW": "allowanceNotInReview",
  "ALLOWANCES.REOPEN_APPROVED AUTHORITY REQUIRED": "allowancesReopenRequired",
  "ONLY AN APPROVED SHEET CAN BE REOPENED": "onlyApprovedSheetReopen",
  // v2.3.43 step 6: permissions, overtime approval, day adjustments.
  "ATTENDANCE.MANAGE_PERMISSIONS AUTHORITY REQUIRED": "managePermissionsRequired",
  "YOU CANNOT DECIDE YOUR OWN PERMISSION": "cannotDecideOwnPermission",
  "INVALID PERMISSION KIND": "invalidPermissionKind",
  "ASK FOR A PERMISSION BEFORE THE DAY - A MANAGER CAN ADD ONE AFTERWARDS": "permissionBeforeDay",
  "PERMISSION NOT FOUND": "permissionNotFound",
  "THIS PERMISSION HAS ALREADY BEEN DECIDED": "permissionAlreadyDecided",
  "MINUTES CANNOT BE NEGATIVE": "minutesNotNegative",
  "NOTHING TO CHANGE": "nothingToChange",
  "ONLY THE OWNER SETS THE OVERTIME POLICY": "overtimePolicyOwnerOnly",
  "INVALID OVERTIME POLICY": "invalidOvertimePolicy",
  "INVALID BREAK RULES": "invalidBreakRules",
  "CHOOSE A PERIOD OF UP TO THREE MONTHS": "periodUpToThreeMonths",
  // v2.3.43 step 7: leave types and their rules.
  "THIS LEAVE TYPE NEEDS A DOCUMENT": "leaveNeedsDocument",
  "INVALID DOCUMENT": "invalidDocument",
  "NOT ENOUGH LEAVE BALANCE": "notEnoughLeaveBalance",
  // v2.3.54: leave recorded on someone's behalf (grant_prosm_time_leave).
  "YOU CANNOT GRANT LEAVE TO YOURSELF": "grantLeaveSelf",
  "CHOOSE SOMEONE WHO CAN APPROVE YOUR LEAVE": "chooseLeaveReviewer",
  "THIS EMPLOYEE ALREADY HAS A PENDING OR APPROVED LEAVE ON THESE DATES": "grantLeaveOverlap",
  "INVALID LEAVE TYPE": "invalidLeaveType",
  "YOU ARE NOT AUTHORIZED TO REVIEW LEAVE REQUESTS": "notAuthorizedReviewLeave",
  "END DATE MUST NOT BE BEFORE START DATE": "endBeforeStart",
  "LEAVE.MANAGE_TYPES AUTHORITY REQUIRED": "manageLeaveTypesRequired",
  "LEAVE TYPE NOT FOUND": "leaveTypeNotFound",
  "INVALID LEAVE TYPE SETTINGS": "invalidLeaveTypeSettings",
  "A LEAVE TYPE WITH THIS KEY ALREADY EXISTS": "leaveTypeKeyExists",
  "EMPLOYEES.EDIT AUTHORITY REQUIRED": "employeesEditRequired",
  "THE HIRE DATE CANNOT BE IN THE FUTURE": "hireDateFuture",
  // v2.3.43 step 8: approved leave is cancelled only before it starts.
  "THIS LEAVE HAS STARTED AND CAN NO LONGER BE CANCELLED": "leaveStartedCannotCancel",
  // v2.3.43 step 9: unpaid leave deduction.
  "LEAVE.SET_DEDUCTION AUTHORITY REQUIRED": "leaveSetDeductionRequired",
  "THE DEDUCTION PER DAY IS REQUIRED FOR UNPAID LEAVE": "deductionPerDayRequired",
  "ONLY THE OWNER CHANGES A RECORDED DEDUCTION": "deductionOwnerOnly",
  "ONLY APPROVED UNPAID LEAVE HAS A DEDUCTION": "onlyApprovedUnpaidDeduction",
  // v2.3.43 step 10: on-behalf time and place.
  "THE TIME MUST BE WITHIN THE LAST 7 DAYS AND NOT IN THE FUTURE": "onBehalfTimeWindow",
  "THIS TIME OVERLAPS A RECORDED SHIFT": "onBehalfOverlap",
  "THE CLOCK-OUT TIME MUST BE AFTER THE CLOCK-IN AND NOT IN THE FUTURE": "onBehalfClockOutTime",
  // v2.3.43 step 11: capture integrity.
  "SITES.MANAGE_INTEGRITY AUTHORITY REQUIRED": "manageIntegrityRequired",
  "INVALID LIVENESS MODE": "invalidLivenessMode",
  "ATTENDANCE.REVIEW_INTEGRITY_FLAGS AUTHORITY REQUIRED": "reviewIntegrityRequired",
  "REVIEW ITEM NOT FOUND": "reviewItemNotFound",
  // v2.3.43 step 12: leaving the site.
  "SITES.MANAGE_EXIT_POLICY AUTHORITY REQUIRED": "manageExitPolicyRequired",
  "INVALID EXIT POLICY": "invalidExitPolicy",
  // v2.3.43 step 17: the manager dashboard
  "DASHBOARD.VIEW AUTHORITY REQUIRED": "dashboardViewRequired",
  "INVALID LAYOUT": "invalidLayout",
  // v2.3.43 step 21: the trial could not be marked (fails closed)
  "The trial could not be started. Please try again.": "trialSetupFailed",
};
