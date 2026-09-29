import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";

import { useAuth } from "../core/context/AuthContext";
import TrialEndedPage from "../modules/activation/TrialEndedPage";
import useTrialStatus from "../modules/activation/useTrialStatus";

// PROSM Time - the client-side redirect ONLY. It is never the real
// authorization boundary (§9: "the client only reflects, never
// enforces, permission state") - every actual data read behind this is
// itself RLS-scoped server-side, so a bookmarked/typed protected URL
// with no real session still resolves to empty data, not a client
// bypass.
//
// § live UX review, user-directed - "the splash screen has no use,
// remove it entirely." Renders nothing while the auth check resolves
// (typically near-instant) rather than any placeholder screen.
export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const { loading, isAuthenticated } = useAuth();
  // Demo (owner 2026-09-29): an ended trial shows its own page (the server locks its data too).
  const trial = useTrialStatus(isAuthenticated);

  if (loading || trial.loading) {
    return null;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (trial.status?.locked) {
    return <TrialEndedPage status={trial.status} onReopened={() => window.location.assign("/dashboard")} />;
  }

  return <>{children}</>;
}
