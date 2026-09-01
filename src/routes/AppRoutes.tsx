import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { AuthProvider, useAuth } from "../core/context/AuthContext";
import ProtectedRoute from "./ProtectedRoute";
import AppShell from "../layouts/AppShell";

import ActivationPage from "../modules/activation/ActivationPage";
import LoginPage from "../modules/auth/LoginPage";
import AcceptInvitationPage from "../modules/onboarding/AcceptInvitationPage";
import DashboardPage from "../modules/dashboard/DashboardPage";
import PeoplePage from "../modules/people/PeoplePage";
import PersonDetailPage from "../modules/people/PersonDetailPage";
import SitesPage from "../modules/sites/SitesPage";
import SiteDetailPage from "../modules/sites/SiteDetailPage";
import ManagerConsolePage from "../modules/manager/ManagerConsolePage";
import TimesheetsPage from "../modules/timesheets/TimesheetsPage";
import TimesheetReportPage from "../modules/timesheets/TimesheetReportPage";
import KioskPage from "../modules/kiosk/KioskPage";

// PROSM Time route map. /activate, /login, /accept-invitation are
// public (no session exists yet by definition at any of them) and
// render standalone (no shell - there is nothing to navigate yet).
// Every protected destination is nested under one AppShell layout
// route (Header + Sidebar + Main, § visual consistency pass) inside
// ProtectedRoute, so the shell mounts once and every page inside it is
// just its own content. Root redirects to whichever of those the
// current session state actually calls for - never a bare
// unauthenticated home screen.
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
            element={
              <ProtectedRoute>
                <AppShell />
              </ProtectedRoute>
            }
          >
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/people" element={<PeoplePage />} />
            <Route path="/people/:userId" element={<PersonDetailPage />} />
            <Route path="/sites" element={<SitesPage />} />
            <Route path="/sites/:siteId" element={<SiteDetailPage />} />
            <Route path="/manager" element={<ManagerConsolePage />} />
            <Route path="/timesheets" element={<TimesheetsPage />} />
            <Route path="/timesheets/:timesheetId/report" element={<TimesheetReportPage />} />
            <Route path="/kiosk/:siteId" element={<KioskPage />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
