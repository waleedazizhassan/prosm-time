import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { AuthProvider, useAuth } from "../core/context/AuthContext";
import ProtectedRoute from "./ProtectedRoute";

import ActivationPage from "../modules/activation/ActivationPage";
import LoginPage from "../modules/auth/LoginPage";
import AcceptInvitationPage from "../modules/onboarding/AcceptInvitationPage";
import DashboardPage from "../modules/dashboard/DashboardPage";
import PeoplePage from "../modules/people/PeoplePage";
import PersonDetailPage from "../modules/people/PersonDetailPage";

// PROSM Time route map. /activate, /login, /accept-invitation are
// public (no session exists yet by definition at any of them);
// /dashboard, /people, /people/:userId are protected. Root redirects to
// whichever of those the current session state actually calls for -
// never a bare unauthenticated home screen.
function RootRedirect() {
  const { loading, isAuthenticated } = useAuth();

  if (loading) return null;

  return <Navigate to={isAuthenticated ? "/dashboard" : "/activate"} replace />;
}

export default function AppRoutes() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route path="/activate" element={<ActivationPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/accept-invitation" element={<AcceptInvitationPage />} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <DashboardPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/people"
            element={
              <ProtectedRoute>
                <PeoplePage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/people/:userId"
            element={
              <ProtectedRoute>
                <PersonDetailPage />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
