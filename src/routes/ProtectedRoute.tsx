import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";

import { useAuth } from "../core/context/AuthContext";
import SplashScreen from "../modules/splash/SplashScreen";

// PROSM Time - the client-side redirect ONLY. It is never the real
// authorization boundary (§9: "the client only reflects, never
// enforces, permission state") - every actual data read behind this is
// itself RLS-scoped server-side, so a bookmarked/typed protected URL
// with no real session still resolves to empty data, not a client
// bypass.
export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const { loading, isAuthenticated } = useAuth();

  if (loading) {
    return <SplashScreen />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
