import { Navigate } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";
import PageShell from "../../components/common/PageShell";
import ClockInOutCard from "../dashboard/ClockInOutCard";
import clockInOutHeaderImage from "../../assets/illustrations/clockIn.svg";
import PageBanner from "../../components/common/PageBanner";

// § user-directed - "the Owner/Manager shouldn't have the clock-in
// widget on their own Dashboard the way an Employee does - a sidebar
// entry that takes them to a dedicated page is more logical." Same
// ClockInOutCard every Employee already uses on their own Dashboard -
// this page is purely a different place to reach it from, not a
// second implementation.
export default function ClockInPage() {
  const { profile } = useAuth();
  // Owner 2026-10-18: the Owner does not clock in or out (refused by the server too).
  if (profile?.isOwner) return <Navigate to="/dashboard" replace />;

  return (
    <PageShell title="">
      <PageBanner pageId="clockIn" illustration={clockInOutHeaderImage} />

      <ClockInOutCard />
    </PageShell>
  );
}
