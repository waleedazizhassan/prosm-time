import type { LucideIcon } from "lucide-react";
import { Users, MapPin, LayoutGrid, FileText, FileBarChart, Settings, HelpCircle, Clock, Wallet, Siren, CalendarDays, CalendarClock, CalendarRange, MonitorSmartphone, UserCog, LogIn, Plug, HardHat, ScrollText, Sunrise, Banknote, Receipt, Megaphone, AlertTriangle, IdCard, FileCheck, Gavel } from "lucide-react";

import { FEATURES } from "../../config/features";
import type { PlanFeature } from "../../core/hooks/usePlanFeatures";

// § live UX review, user-directed - "professional reorganization" of
// the Sidebar into grouped sections/"centers" instead of one flat
// list (the earlier "Menu screen" grouping only ever had one real
// group, "organization" - this actually splits it): attendance-facing
// tools, people/sites, payroll (timesheets+allowances), a new Reports
// Center, a new Settings section, and Help.
// 2026-11-09 B-05: the groups follow the target sidebar tree (spec 25.4) - "attendance" is Field
// operations (attendance, sites, leave and holidays, shifts, kiosk), "people" Human resources,
// "payroll" Payroll, "reports" Reports and analytics, "settings" Administration and governance.
// The ids stay, so nothing that refers to them breaks; every path is unchanged.
export type NavSection = "attendance" | "sites" | "people" | "payroll" | "reports" | "settings" | "help";

export interface NavItem {
  id: string;
  labelKey: string;
  path: string;
  icon: LucideIcon;
  // §30: "Navigation must be explicitly designed and implemented,
  // appropriate to the user's role, and must respect authorization -
  // users never see administrative navigation items for which they
  // have no permission." null means every authenticated org member
  // sees it; anything else is a real permission key from the WP-04
  // catalog, checked via the same hasPermission() every other gated
  // control in this app already uses - never a second, parallel
  // authorization concept.
  /** one key, or several (any of them is enough) */
  requiredPermission: string | string[] | null;
  // § live UX review, user-directed - Settings is Owner-only (matches
  // its page's own gate) but isn't backed by a permission-catalog key
  // the way every other item above is - a dedicated boolean rather
  // than inventing a fake permission string for one nav item.
  ownerOnly?: boolean;
  // § user-directed, 2026-09-11 - "the Owner shouldn't even have a
  // Leave page - they're not requesting leave from anyone." The
  // inverse of ownerOnly above: hidden specifically FROM the Owner,
  // visible to everyone else who'd otherwise see it (here: every
  // authenticated member, same as requiredPermission: null already
  // means for this one item).
  hiddenFromOwner?: boolean;
  /** Only the owner as a person - not a person holding the owner's authority (owner 2026-11-04). */
  realOwnerOnly?: boolean;
  // Owner 2026-10-19: shown only to the Owner and Managers (e.g. the workers' kiosk).
  ownerOrManagerOnly?: boolean;
  // Owner 2026-11-03: hidden when the organisation's plan does not include it.
  planFeature?: PlanFeature;
  // § live UX review, user-directed - "Menu" screen reference material
  // grouped its items under labeled sections rather than one flat
  // list. Pure presentational grouping of the exact same items/
  // permissions above - no new nav destination is introduced here.
  section: NavSection;
}

// § final visual consistency pass, correction - "The Dashboard button
// must exist in the HEADER only... remove the duplicate Dashboard
// entry/button from the Sidebar." HeaderNavControls' own Dashboard
// shortcut (added in an earlier pass of this same finishing sweep) is
// now the ONLY Dashboard navigation mechanism - no Dashboard entry
// lives here anymore.
const ALL_NAV_ITEMS: NavItem[] = [
  // § user-directed - Owner/Manager no longer carry the personal
  // clock-in widget on their own Dashboard (point 5, 2026-09-11: "the
  // Owner and Manager shouldn't have the clock-in widget on the
  // Dashboard the way an Employee does"); this is the sidebar entry
  // that takes them to it instead. § correction, same day - the user
  // explicitly meant this for the Owner/Manager ONLY, not a redundant
  // second entry for an Employee who already has the widget on their
  // own Dashboard. "attendance.view" is exactly the Owner+Manager
  // audience already established for Manager Console below (same
  // permission key, same real audience per the multirole audit).
  // Owner 2026-10-18: the Owner does not clock in or out.
  { id: "clockIn", labelKey: "items.clockIn", path: "/clock-in", icon: LogIn, requiredPermission: "attendance.view", hiddenFromOwner: true, section: "attendance" },
  { id: "manager", labelKey: "items.manager", path: "/manager", icon: LayoutGrid, requiredPermission: "attendance.view", section: "attendance" },
  // § live UX review, user-directed - "a direct sidebar button to view
  // employees' clock-in/clock-out record." No permission gate, same
  // reasoning as Timesheets below: attendance_sessions' own RLS
  // already returns exactly what the caller may see (their own
  // sessions always; a Manager's managed-site people; everyone for
  // the Owner), so every authenticated member can open this item and
  // simply gets their own scope back.
  { id: "attendance", labelKey: "items.attendance", path: "/attendance", icon: Clock, requiredPermission: null, section: "attendance" },
  // Owner 2026-11-09: the out-of-area moments to explain, on their own page
  { id: "exceptions", labelKey: "items.exceptions", path: "/exceptions", icon: AlertTriangle, requiredPermission: null, hiddenFromOwner: true, section: "attendance" },
  // § user-directed follow-up - a direct sidebar entry for
  // Administrative Clock In/Out (On Behalf Of), previously only
  // reachable via a specific employee's own People > detail page. Same
  // AdminAttendanceCard, same authorization, just a picker in front of
  // it - no new capability.
  { id: "adminClock", planFeature: "on_behalf", labelKey: "items.adminClock", path: "/admin-clock", icon: UserCog, requiredPermission: "attendance.clock_in_on_behalf", section: "attendance" },
  // § user-directed - real advance shift scheduling/rostering
  // (20260908220000). Self-access to one's own upcoming shifts needs
  // no special permission, same reasoning as Timesheets/Allowances/
  // Leave above - the management section within the page itself gates
  // on schedules.manage (an established permission, unused until now).
  { id: "schedule", labelKey: "items.schedule", path: "/schedule", icon: CalendarClock, requiredPermission: null, section: "attendance" },
  // § user-directed - "bring Kiosk mode back into the sidebar" (it was
  // reachable only via a direct /kiosk/:siteId URL, invisible from
  // navigation). Open to every authenticated member, same reasoning as
  // Attendance Record above - the real identity check inside kiosk mode
  // is the PIN, not who launched the screen.
  { id: "kiosk", planFeature: "kiosk", labelKey: "items.kiosk", path: "/kiosk", icon: MonitorSmartphone, requiredPermission: null, ownerOrManagerOnly: true, section: "sites" },
  // § live UX review, user-directed - a real Emergency Log for SOS
  // alerts (exact GPS location, time, employee, site), reached from
  // both the sidebar and the notification bell/siren overlay. Gated on
  // the same permission sos_alerts' own RLS uses for org-wide
  // visibility - a plain employee sees nothing useful here (only their
  // own alerts, if any), same as Manager Console's own gate.
  { id: "emergencyLog", planFeature: "sos", labelKey: "items.emergencyLog", path: "/emergency-log", icon: Siren, requiredPermission: "attendance.view", section: "attendance" },
  { id: "people", labelKey: "items.people", path: "/people", icon: Users, requiredPermission: "employees.view", section: "people" },
  // 2026-11-09 Media Center: announcements and official statements - everyone reads what was addressed to them.
  { id: "announcements", planFeature: "announcements", labelKey: "items.announcements", path: "/announcements", icon: Megaphone, requiredPermission: null, section: "people" },
  { id: "sites", labelKey: "items.sites", path: "/sites", icon: MapPin, requiredPermission: "sites.manage", section: "sites" },
  // Owner 2026-10-18/19: external workers for the whole organisation (app-generated kiosk numbers).
  // Owner 2026-11-09: one item "External labour" - the workers, and their pay inside it
  { id: "workers", planFeature: "kiosk", labelKey: "items.workers", path: "/workers", icon: HardHat, requiredPermission: ["sites.manage", "external_labor.view_pay"], section: "sites" },
  // §22: "Employee reviews their period" - self-access to one's own
  // timesheets needs no special permission (same as Dashboard), so
  // this nav item is visible to every authenticated org member; the
  // page itself further gates its Generate/Approve/Correction-review
  // sections on timesheets.generate/timesheets.approve/attendance.correct.
  { id: "timesheets", labelKey: "items.timesheets", path: "/timesheets", icon: FileText, requiredPermission: null, section: "payroll" },
  // § approved 2026-09-02 plan (Feature 2) - self-access to one's own
  // allowance entries needs no special permission, same reasoning as
  // Timesheets above; allowance_entries' own RLS is what actually
  // scopes what an approver sees.
  { id: "allowances", planFeature: "allowances", labelKey: "items.allowances", path: "/allowances", icon: Wallet, requiredPermission: null, section: "payroll" },
  // § user-directed - real PTO/leave management (20260908200000).
  // Self-access to one's own leave requests/balance needs no special
  // permission, same reasoning as Timesheets/Allowances above -
  // leave_requests' own RLS is what actually scopes what a supervisor
  // sees (Manager Console's own new review section).
  // 2026-11-08: the payroll module (its own payroll.* permissions; the owner holds them all) and
  // each person's own published payslips.
  { id: "payroll", planFeature: "payroll", labelKey: "items.payroll", path: "/payroll", icon: Banknote, requiredPermission: "payroll.access", section: "payroll" },
  { id: "payslips", planFeature: "payroll", labelKey: "items.payslips", path: "/payslips", icon: Receipt, requiredPermission: null, hiddenFromOwner: true, section: "payroll" },
  // 2026-11-11 HR suite: the person's own file (read only; their documents and warnings)
  // 2026-11-11 HR suite feature 2: the company's documents and their expiry dates (personnel managers)
  { id: "documents", planFeature: "documents", labelKey: "items.documents", path: "/documents", icon: FileCheck, requiredPermission: "hr.manage", section: "people" },
  // 2026-11-11 HR suite feature 1: penalties and incentives (personnel managers, managers and supervisors)
  { id: "penalties", planFeature: "penalties", labelKey: "items.penalties", path: "/penalties", icon: Gavel, requiredPermission: ["hr.manage", "employees.view"], section: "people" },
  { id: "myProfile", labelKey: "items.myProfile", path: "/me", icon: IdCard, requiredPermission: null, hiddenFromOwner: true, section: "people" },
  { id: "leave", planFeature: "leave", labelKey: "items.leave", path: "/leave", icon: CalendarDays, requiredPermission: null, section: "people" },
  // § live UX review, user-directed - "a Reports Center where any PDF
  // can be pulled." No permission gate on the nav item itself - the
  // page's own report-type selector gates each report by the exact
  // same permission its original source page already used.
  // Owner 2026-11-09: an employee takes every report from its own page; Reports is for those who manage
  { id: "reports", labelKey: "items.reports", path: "/reports", icon: FileBarChart, requiredPermission: "exceptions.manage", section: "reports" },
  // owner 2026-11-03: the morning summary opens here - one day, any day, with the names
  { id: "dailySummary", planFeature: "daily_summary", labelKey: "items.dailySummary", path: "/daily-summary", icon: Sunrise, requiredPermission: null, ownerOnly: true, section: "reports" },
  // Owner 2026-10-28: the action log on its own page (it left the dashboard).
  { id: "auditLog", planFeature: "audit", labelKey: "items.auditLog", path: "/audit-log", icon: ScrollText, requiredPermission: "audit.view", section: "settings" },
  // § live UX review, user-directed - a real home for org-wide
  // settings (today: the no-site geofence radius) instead of living
  // inside an unrelated page. Owner-only, matching that setting's own
  // existing RPC-level gate.
  // Owner 2026-10-20: every setting lives here - each site's rules too, so managers who manage sites see it.
  { id: "settings", labelKey: "items.settings", path: "/settings", icon: Settings, requiredPermission: "sites.manage", section: "settings" },
  // § user-directed 2026-09-09 - "API [keys] should appear on its own
  // in the sidebar, not inside Settings." Same Owner-only gate as
  // Settings itself (API keys grant external read access to this
  // organization's own attendance data - not a lesser-privilege
  // action).
  // § hidden 2026-09-13 ("hide it, not delete it, until we know how
  // we'll actually use it"), re-shown 2026-09-15 - now real, load-
  // bearing infrastructure: PROSM Projects and PROSM Finance both
  // actively depend on keys generated here (attendance:read/
  // payroll:read) for their own cross-product data bridges, so the
  // "how we'll use it" question is answered.
  // v2.3.43 step 3 (items 7/8): public holidays, weekly rest days and exceptional days.
  { id: "calendar", labelKey: "items.calendar", path: "/calendar", icon: CalendarRange, requiredPermission: "calendar.manage", section: "settings" },
  { id: "integrations", planFeature: "integrations", labelKey: "items.integrations", path: "/integrations", icon: Plug, requiredPermission: null, ownerOnly: true, section: "settings" },
  { id: "help", labelKey: "items.help", path: "/help", icon: HelpCircle, requiredPermission: null, section: "help" },
];

// Hidden features (src/config/features.ts) leave the sidebar and the search.
export const NAV_ITEMS: NavItem[] = ALL_NAV_ITEMS.filter((item) => item.id !== "integrations" || FEATURES.integrations);

// Owner 2026-11-09 ("the sidebar tree needs work"): daily operations, sites and external labour, people
// (with leave and announcements), payroll, reports, management.
export const NAV_SECTION_ORDER: NavSection[] = ["attendance", "sites", "people", "payroll", "reports", "settings", "help"];
