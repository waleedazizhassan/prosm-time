import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { AuthProvider, useAuth } from "../core/context/AuthContext";
import ProtectedRoute from "./ProtectedRoute";
import AppShell from "../layouts/AppShell";

import ActivationPage from "../modules/activation/ActivationPage";
import WelcomePage from "../modules/auth/WelcomePage";
import LoginPage from "../modules/auth/LoginPage";
import ForgotPasswordPage from "../modules/auth/ForgotPasswordPage";
import ResetPasswordPage from "../modules/auth/ResetPasswordPage";
import AcceptInvitationPage from "../modules/onboarding/AcceptInvitationPage";
import DashboardPage from "../modules/dashboard/DashboardPage";
import PeoplePage from "../modules/people/PeoplePage";
import PersonDetailPage from "../modules/people/PersonDetailPage";
import SitesPage from "../modules/sites/SitesPage";
import SiteDetailPage from "../modules/sites/SiteDetailPage";
import ManagerConsolePage from "../modules/manager/ManagerConsolePage";
import AttendanceLogPage from "../modules/attendance/AttendanceLogPage";
import TimesheetsPage from "../modules/timesheets/TimesheetsPage";
import TimesheetReportPage from "../modules/timesheets/TimesheetReportPage";
import AllowancesPage from "../modules/allowances/AllowancesPage";
import LeaveRequestsPage from "../modules/leave/LeaveRequestsPage";
import SchedulePage from "../modules/schedule/SchedulePage";
import EmergencyLogPage from "../modules/emergency/EmergencyLogPage";
import ReportsPage from "../modules/reports/ReportsPage";
import OrganizationSettingsPage from "../modules/settings/OrganizationSettingsPage";
import IntegrationsPage from "../modules/settings/IntegrationsPage";
import KioskPage from "../modules/kiosk/KioskPage";
import KioskLauncherPage from "../modules/kiosk/KioskLauncherPage";
import HelpPage from "../modules/help/HelpPage";

// PROSM Time route map. /activate, /login, /accept-invitation are
// public (no session exists yet by definition at any of them) and
// render standalone (no shell - there is nothing to navigate yet).
// Every protected destination is nested under one AppShell layout
// route (Header + Sidebar + Main, § visual consistency pass) inside
// ProtectedRoute, so the shell mounts once and every page inside it is
// just its own content. Root redirects to whichever of those the
// current session state actually calls for - never a bare
// unauthenticated home screen.
// § live UX review, user-directed - "the splash screen has no use,
// remove it entirely." Renders nothing while the auth check resolves
// (typically near-instant) rather than any placeholder screen.
function RootRedirect() {
  const { loading, isAuthenticated } = useAuth();

  if (loading) return null;

  return <Navigate to={isAuthenticated ? "/dashboard" : "/welcome"} replace />;
}

export default function AppRoutes() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route path="/welcome" element={<WelcomePage />} />
          <Route path="/activate" element={<ActivationPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
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
            <Route path="/attendance" element={<AttendanceLogPage />} />
            <Route path="/timesheets" element={<TimesheetsPage />} />
            <Route path="/timesheets/:timesheetId/report" element={<TimesheetReportPage />} />
            <Route path="/allowances" element={<AllowancesPage />} />
            <Route path="/leave" element={<LeaveRequestsPage />} />
            <Route path="/schedule" element={<SchedulePage />} />
            <Route path="/emergency-log" element={<EmergencyLogPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/settings" element={<OrganizationSettingsPage />} />
            <Route path="/integrations" element={<IntegrationsPage />} />
            <Route path="/kiosk" element={<KioskLauncherPage />} />
            <Route path="/kiosk/:siteId" element={<KioskPage />} />
            <Route path="/help" element={<HelpPage />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
