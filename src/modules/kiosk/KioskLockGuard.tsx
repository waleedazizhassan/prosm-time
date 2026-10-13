import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";
import { getLockedKioskSite, kioskPath, unlockKiosk } from "./kioskLock";

// Audit 1.3 - while a kiosk is open on this device every other address
// (typed, bookmarked, browser back/forward) leads back to it. A signed-out
// device has no kiosk to return to (the kiosk calls need the session), so
// the lock is dropped and sign-in shows normally.
export default function KioskLockGuard({ children }: { children: ReactNode }) {
  const { loading, isAuthenticated } = useAuth();
  const { pathname } = useLocation();
  const lockedSite = getLockedKioskSite();

  if (!lockedSite || loading) return <>{children}</>;

  if (!isAuthenticated) {
    unlockKiosk();
    return <>{children}</>;
  }

  const target = kioskPath(lockedSite);
  if (pathname !== target) return <Navigate to={target} replace />;

  return <>{children}</>;
}
