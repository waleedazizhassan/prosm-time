import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";

import { useAuth } from "../core/context/AuthContext";

// Screens review 2026-11-12: a page someone has no right to (opened from an old link or typed in) sends them
// to their home page instead of opening with errors - the same rule as the menu. The server refuses it anyway.
export default function AccessRoute({ anyOf, ownerOnly = false, children }: { anyOf?: string[]; ownerOnly?: boolean; children: ReactNode }) {
  const { hasPermission, profile } = useAuth();
  if (!profile) return <>{children}</>;
  const allowed = ownerOnly ? Boolean(profile.isOwner) : !anyOf || anyOf.some((key) => hasPermission(key));
  return allowed ? <>{children}</> : <Navigate to="/dashboard" replace />;
}
