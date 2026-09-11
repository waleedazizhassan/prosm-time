import type { LucideIcon } from "lucide-react";
import { Users, MapPin, LayoutGrid, FileText, FileBarChart, Settings, HelpCircle, Clock, Wallet, Siren, CalendarDays, CalendarClock, Plug, MonitorSmartphone, UserCog, LogIn } from "lucide-react";

// § live UX review, user-directed - "professional reorganization" of
// the Sidebar into grouped sections/"centers" instead of one flat
// list (the earlier "Menu screen" grouping only ever had one real
// group, "organization" - this actually splits it): attendance-facing
// tools, people/sites, payroll (timesheets+allowances), a new Reports
// Center, a new Settings section, and Help.
export type NavSection = "attendance" | "people" | "payroll" | "reports" | "settings" | "help";

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
  requiredPermission: string | null;
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
export const NAV_ITEMS: NavItem[] = [
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
  { id: "clockIn", labelKey: "items.clockIn", path: "/clock-in", icon: LogIn, requiredPermission: "attendance.view", section: "attendance" },
  { id: "manager", labelKey: "items.manager", path: "/manager", icon: LayoutGrid, requiredPermission: "attendance.view", section: "attendance" },
  // § live UX review, user-directed - "a direct sidebar button to view
  // employees' clock-in/clock-out record." No permission gate, same
  // reasoning as Timesheets below: attendance_sessions' own RLS
  // already returns exactly what the caller may see (their own
  // sessions always; a Manager's managed-site people; everyone for
  // the Owner), so every authenticated member can open this item and
  // simply gets their own scope back.
  { id: "attendance", labelKey: "items.attendance", path: "/attendance", icon: Clock, requiredPermission: null, section: "attendance" },
  // § user-directed follow-up - a direct sidebar entry for
  // Administrative Clock In/Out (On Behalf Of), previously only
  // reachable via a specific employee's own People > detail page. Same
  // AdminAttendanceCard, same authorization, just a picker in front of
  // it - no new capability.
  { id: "adminClock", labelKey: "items.adminClock", path: "/admin-clock", icon: UserCog, requiredPermission: "attendance.clock_in_on_behalf", section: "attendance" },
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
  { id: "kiosk", labelKey: "items.kiosk", path: "/kiosk", icon: MonitorSmartphone, requiredPermission: null, section: "attendance" },
  // § live UX review, user-directed - a real Emergency Log for SOS
  // alerts (exact GPS location, time, employee, site), reached from
  // both the sidebar and the notification bell/siren overlay. Gated on
  // the same permission sos_alerts' own RLS uses for org-wide
  // visibility - a plain employee sees nothing useful here (only their
  // own alerts, if any), same as Manager Console's own gate.
  { id: "emergencyLog", labelKey: "items.emergencyLog", path: "/emergency-log", icon: Siren, requiredPermission: "attendance.view", section: "attendance" },
  { id: "people", labelKey: "items.people", path: "/people", icon: Users, requiredPermission: "employees.view", section: "people" },
  { id: "sites", labelKey: "items.sites", path: "/sites", icon: MapPin, requiredPermission: "sites.manage", section: "people" },
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
  { id: "allowances", labelKey: "items.allowances", path: "/allowances", icon: Wallet, requiredPermission: null, section: "payroll" },
  // § user-directed - real PTO/leave management (20260908200000).
  // Self-access to one's own leave requests/balance needs no special
  // permission, same reasoning as Timesheets/Allowances above -
  // leave_requests' own RLS is what actually scopes what a supervisor
  // sees (Manager Console's own new review section).
  { id: "leave", labelKey: "items.leave", path: "/leave", icon: CalendarDays, requiredPermission: null, hiddenFromOwner: true, section: "payroll" },
  // § live UX review, user-directed - "a Reports Center where any PDF
  // can be pulled." No permission gate on the nav item itself - the
  // page's own report-type selector gates each report by the exact
  // same permission its original source page already used.
  { id: "reports", labelKey: "items.reports", path: "/reports", icon: FileBarChart, requiredPermission: null, section: "reports" },
  // § live UX review, user-directed - a real home for org-wide
  // settings (today: the no-site geofence radius) instead of living
  // inside an unrelated page. Owner-only, matching that setting's own
  // existing RPC-level gate.
  { id: "settings", labelKey: "items.settings", path: "/settings", icon: Settings, requiredPermission: null, ownerOnly: true, section: "settings" },
  // § user-directed 2026-09-09 - "API [keys] should appear on its own
  // in the sidebar, not inside Settings." Same Owner-only gate as
  // Settings itself (API keys grant external read access to this
  // organization's own attendance data - not a lesser-privilege
  // action).
  { id: "integrations", labelKey: "items.integrations", path: "/integrations", icon: Plug, requiredPermission: null, ownerOnly: true, section: "settings" },
  { id: "help", labelKey: "items.help", path: "/help", icon: HelpCircle, requiredPermission: null, section: "help" },
];

export const NAV_SECTION_ORDER: NavSection[] = ["attendance", "people", "payroll", "reports", "settings", "help"];
