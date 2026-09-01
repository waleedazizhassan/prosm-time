import type { LucideIcon } from "lucide-react";
import { LayoutDashboard, Users, MapPin, LayoutGrid } from "lucide-react";

export interface NavItem {
  id: string;
  labelKey: string;
  path: string;
  icon: LucideIcon;
  // §30: "Navigation must be explicitly designed and implemented,
  // appropriate to the user's role, and must respect authorization -
  // users never see administrative navigation items for which they
  // have no permission." null means every authenticated org member
  // sees it (Dashboard); anything else is a real permission key from
  // the WP-04 catalog, checked via the same hasPermission() every
  // other gated control in this app already uses - never a second,
  // parallel authorization concept.
  requiredPermission: string | null;
}

export const NAV_ITEMS: NavItem[] = [
  { id: "dashboard", labelKey: "items.dashboard", path: "/dashboard", icon: LayoutDashboard, requiredPermission: null },
  { id: "people", labelKey: "items.people", path: "/people", icon: Users, requiredPermission: "employees.view" },
  { id: "sites", labelKey: "items.sites", path: "/sites", icon: MapPin, requiredPermission: "sites.manage" },
  { id: "manager", labelKey: "items.manager", path: "/manager", icon: LayoutGrid, requiredPermission: "attendance.view" },
];
