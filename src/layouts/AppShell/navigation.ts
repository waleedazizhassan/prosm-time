import type { LucideIcon } from "lucide-react";
import { Users, MapPin, LayoutGrid, FileText, HelpCircle, Clock } from "lucide-react";

export type NavSection = "organization" | "help";

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
  { id: "people", labelKey: "items.people", path: "/people", icon: Users, requiredPermission: "employees.view", section: "organization" },
  { id: "sites", labelKey: "items.sites", path: "/sites", icon: MapPin, requiredPermission: "sites.manage", section: "organization" },
  { id: "manager", labelKey: "items.manager", path: "/manager", icon: LayoutGrid, requiredPermission: "attendance.view", section: "organization" },
  // § live UX review, user-directed - "a direct sidebar button to view
  // employees' clock-in/clock-out record." No permission gate, same
  // reasoning as Timesheets below: attendance_sessions' own RLS
  // already returns exactly what the caller may see (their own
  // sessions always; a Manager's managed-site people; everyone for
  // the Owner), so every authenticated member can open this item and
  // simply gets their own scope back.
  { id: "attendance", labelKey: "items.attendance", path: "/attendance", icon: Clock, requiredPermission: null, section: "organization" },
  // §22: "Employee reviews their period" - self-access to one's own
  // timesheets needs no special permission (same as Dashboard), so
  // this nav item is visible to every authenticated org member; the
  // page itself further gates its Generate/Approve/Correction-review
  // sections on timesheets.generate/timesheets.approve/attendance.correct.
  { id: "timesheets", labelKey: "items.timesheets", path: "/timesheets", icon: FileText, requiredPermission: null, section: "organization" },
  { id: "help", labelKey: "items.help", path: "/help", icon: HelpCircle, requiredPermission: null, section: "help" },
];

export const NAV_SECTION_ORDER: NavSection[] = ["organization", "help"];
