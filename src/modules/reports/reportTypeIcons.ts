import {
  Clock,
  Wallet,
  FileText,
  Users,
  HardHat,
  MapPin,
  AlarmClock,
  LogOut,
  CalendarX,
  ShieldAlert,
  Navigation,
  Siren,
  type LucideIcon,
} from "lucide-react";

// § point 3, 2026-09-11 - "the report-type buttons' current pill/tab
// look isn't great, small cards with an illustrative icon next to each
// would be better." One icon per report type, purely presentational -
// no change to what any report type actually does or returns.
export const REPORT_TYPE_ICONS: Record<string, LucideIcon> = {
  attendance: Clock,
  allowances: Wallet,
  timesheets: FileText,
  workforce: Users,
  contractor: HardHat,
  site: MapPin,
  late: AlarmClock,
  missingCheckouts: LogOut,
  leaveConflicts: CalendarX,
  managerOverrides: ShieldAlert,
  locationViolations: Navigation,
  sos: Siren,
};
