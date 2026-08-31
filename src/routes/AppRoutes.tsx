import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { AuthProvider, useAuth } from "../core/context/AuthContext";
import ProtectedRoute from "./ProtectedRoute";

import ActivationPage from "../modules/activation/ActivationPage";
import LoginPage from "../modules/auth/LoginPage";
import DashboardPage from "../modules/dashboard/DashboardPage";

// PROSM Time WP-03 route map: /activate and /login are public (no
// session exists yet at /activate by definition); /dashboard is
// protected. Root redirects to whichever of those the current session
// state actually calls for - never a bare unauthenticated home screen.
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
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <DashboardPage />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
