import { Navigate } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";
import PageShell from "../../components/common/PageShell";
import EmployeeHome from "../dashboard/EmployeeHome";

// § user-directed - "the Owner/Manager shouldn't have the clock-in
// widget on their own Dashboard the way an Employee does - a sidebar
// entry that takes them to a dedicated page is more logical." Same
// ClockInOutCard every Employee already uses on their own Dashboard -
// this page is purely a different place to reach it from, not a
// second implementation.
export default function ClockInPage() {
  const { profile } = useAuth();
  // Owner 2026-10-18: the Owner does not clock in or out (refused by the server too).
  if (profile?.isRealOwner) return <Navigate to="/dashboard" replace />;

  return (
    // Owner 2026-11-10: managers and supervisors get the same clock-in screen as employees - the map
    // alone (no banner card over it), with the floating "My hours" and reminders buttons.
    <PageShell compact>
      <EmployeeHome />
    </PageShell>
  );
}
