import { useAuth } from "../../core/context/AuthContext";

import PageShell from "../../components/common/PageShell";
import EmployeeHome from "./EmployeeHome";
import ExceptionsCard from "./ExceptionsCard";
import AdminOverviewCard from "./AdminOverviewCard";
import PersonalRemindersCard from "./PersonalRemindersCard";
import ManagerDashboard from "./manager/ManagerDashboard";

// PROSM Time Implementation Master File V3.0, WP-03/§21/§37 - "Admin
// Dashboard." Deliberately minimal and operational: real-time
// attendance is the actual point of this screen (§37). Organization
// identity and the read-only reflection of PROSM Management's license
// state still exist in full - § final visual consistency pass,
// correction moved them out of two large Dashboard cards into a
// compact Header quick-look (HeaderOrganizationCard), consistent with
// PROSM Platform's own Header/OrganizationCard pattern, so this screen
// stays focused on what an employee actually does here. Sign-out and
// cross-page navigation live in the application shell (Sidebar/User
// Menu, Header) - this page only owns its own operational content.
//
// § live UX review, user-directed - an Owner/Admin's Dashboard looked
// identical to an individual employee's, with nothing signaling they
// can see more than their own attendance. AdminOverviewCard renders
// only for attendance.view holders (Manager Console's own gate) and
// shows real counts already available from ManagerRepository/
// SiteRepository - a rollup of existing data, not a new domain
// concept.
export default function DashboardPage() {
  const { profile, hasPermission } = useAuth();

  // § user-directed, point 5 (2026-09-11) - "the Owner and Manager
  // shouldn't have the clock-in widget on their own Dashboard the way
  // an Employee does... a sidebar entry that takes them to a dedicated
  // page is more logical." Uses the same 'exceptions.manage' authority
  // Manager Console/Reports Center already treat as "has real
  // management scope" elsewhere in this pass - Manager and Supervisor
  // both hold it, plain Employee/read_only don't. Owner/Manager still
  // reach the exact same widget via the new /clock-in sidebar entry.
  const hasManagementScope = Boolean(profile?.isOwner) || hasPermission("exceptions.manage");
  const showFullDashboard = Boolean(profile?.isOwner) || hasPermission("dashboard.view");

  // § user-directed, 2026-09-11 - AdminOverviewCard already carries its
  // own complete greeting banner for the Owner/Manager view; PageShell's
  // title/subtitle above it was pure duplication and left an empty gap
  // before the real content. Only the plain Employee view (no rich
  // banner of its own) still needs PageShell's header.
  // Owner 2026-10-19: the dashboard is for the Owner, Managers and
  // Supervisors; everyone else gets their own light home page.
  return (
    <PageShell compact>
      {/* v2.3.43 step 17: the Owner and whoever holds dashboard.view get the
          full dashboard; other management roles keep the light overview. */}
      {showFullDashboard ? <ManagerDashboard /> : hasManagementScope ? <AdminOverviewCard /> : <EmployeeHome />}
      <ExceptionsCard />
      {/* Owner 2026-10-21: each person sets their own clock-in/out reminders (not the Owner). */}
      <PersonalRemindersCard />
    </PageShell>
  );
}
