import { lazy, Suspense } from "react";
import PlanRoute from "./PlanRoute";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import PageLoadBoundary from "../components/common/PageLoadBoundary";

import { AuthProvider, useAuth } from "../core/context/AuthContext";
import ProtectedRoute from "./ProtectedRoute";
import { FEATURES } from "../config/features";
import AppShell from "../layouts/AppShell";
import UpdateAvailableBanner from "../layouts/AppShell/UpdateAvailableBanner";

import ActivationPage from "../modules/activation/ActivationPage";
import WelcomePage from "../modules/auth/WelcomePage";
import LoginPage from "../modules/auth/LoginPage";
import ForgotPasswordPage from "../modules/auth/ForgotPasswordPage";
import ResetPasswordPage from "../modules/auth/ResetPasswordPage";
import AcceptInvitationPage from "../modules/onboarding/AcceptInvitationPage";
import DashboardPage from "../modules/dashboard/DashboardPage";
import ClockInPage from "../modules/attendance/ClockInPage";
import KioskPage from "../modules/kiosk/KioskPage";
import KioskLauncherPage from "../modules/kiosk/KioskLauncherPage";
import KioskLayout from "../modules/kiosk/KioskLayout";
import KioskLockGuard from "../modules/kiosk/KioskLockGuard";

// Pages other than sign-in, the dashboard, clock in and the kiosk are fetched when opened;
// everything a worker needs offline stays in the main file.
const PeoplePage = lazy(() => import("../modules/people/PeoplePage"));
const PersonDetailPage = lazy(() => import("../modules/people/PersonDetailPage"));
const GrantPermissionsPage = lazy(() => import("../modules/people/GrantPermissionsPage"));
const AdminOnBehalfPage = lazy(() => import("../modules/people/AdminOnBehalfPage"));
const AuditLogPage = lazy(() => import("../modules/audit/AuditLogPage"));
const SitesPage = lazy(() => import("../modules/sites/SitesPage"));
const SiteDetailPage = lazy(() => import("../modules/sites/SiteDetailPage"));
const ExternalWorkersPage = lazy(() => import("../modules/workforce/ExternalWorkersPage"));
const ExternalPayPage = lazy(() => import("../modules/workforce/ExternalPayPage"));
const ExternalPayRunPage = lazy(() => import("../modules/workforce/ExternalPayRunPage"));
const ManagerConsolePage = lazy(() => import("../modules/manager/ManagerConsolePage"));
const AttendanceLogPage = lazy(() => import("../modules/attendance/AttendanceLogPage"));
const TimesheetsPage = lazy(() => import("../modules/timesheets/TimesheetsPage"));
const TimesheetReportPage = lazy(() => import("../modules/timesheets/TimesheetReportPage"));
const AllowancesPage = lazy(() => import("../modules/allowances/AllowancesPage"));
const AllowancePricesPage = lazy(() => import("../modules/allowances/AllowancePricesPage"));
const CalendarPage = lazy(() => import("../modules/calendar/CalendarPage"));
const LeaveRequestsPage = lazy(() => import("../modules/leave/LeaveRequestsPage"));
const SchedulePage = lazy(() => import("../modules/schedule/SchedulePage"));
const EmergencyLogPage = lazy(() => import("../modules/emergency/EmergencyLogPage"));
const ReportsPage = lazy(() => import("../modules/reports/ReportsPage"));
const OrganizationSettingsPage = lazy(() => import("../modules/settings/OrganizationSettingsPage"));
const IntegrationsPage = lazy(() => import("../modules/settings/IntegrationsPage"));
const HelpPage = lazy(() => import("../modules/help/HelpPage"));
const DailySummaryPage = lazy(() => import("../modules/reports/DailySummaryPage"));
const LegalPage = lazy(() => import("../modules/legal/LegalPage"));
const PayrollHomePage = lazy(() => import("../modules/payroll/PayrollHomePage"));
const PayrollCyclePage = lazy(() => import("../modules/payroll/PayrollCyclePage"));
const PayrollProfilesPage = lazy(() => import("../modules/payroll/PayrollProfilesPage"));
const PayrollSettingsPage = lazy(() => import("../modules/payroll/PayrollSettingsPage"));
const PayslipRequestsPage = lazy(() => import("../modules/payroll/PayslipRequestsPage"));
const MyPayslipsPage = lazy(() => import("../modules/payroll/MyPayslipsPage"));
const MyProfilePage = lazy(() => import("../modules/people/MyProfilePage"));
const DocumentsPage = lazy(() => import("../modules/documents/DocumentsPage"));
const ExceptionsPage = lazy(() => import("../modules/dashboard/ExceptionsPage"));
const AnnouncementsPage = lazy(() => import("../modules/announcements/AnnouncementsPage"));

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
        {/* § real bug fix, 2026-09-13 - this used to live inside
            AppShell, which only mounts AFTER a real login - a user
            checking for updates from the pre-login Welcome/Login
            screens (a real, observed case: someone opening the app
            fresh just to see if a newer build exists) would never see
            it, even though the underlying poll/compare logic was
            already correct. Hoisted here, above every route including
            the public ones, so it shows regardless of auth state -
            removed from AppShell/index.tsx so it doesn't double-mount
            on authenticated pages. */}
        <PublicUpdateBanner />
        <PageLoadBoundary>
        <Suspense fallback={null}>
        <KioskLockGuard>
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route path="/welcome" element={<WelcomePage />} />
          <Route path="/activate" element={<ActivationPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/accept-invitation" element={<AcceptInvitationPage />} />
          {/* Privacy Policy and Terms of Use - public, no sign-in needed (owner 2026-10-13). */}
          <Route path="/privacy" element={<LegalPage document="privacy" />} />
          <Route path="/terms" element={<LegalPage document="terms" />} />

          {/* Audit 1.3 - the kiosk runs outside the app shell: no sidebar,
              search or user menu, and KioskLockGuard keeps the device on it
              until the exit check passes. */}
          <Route
            path="/kiosk/:siteId"
            element={
              <ProtectedRoute>
                <PlanRoute feature="kiosk">
                  <KioskLayout>
                    <KioskPage />
                  </KioskLayout>
                </PlanRoute>
              </ProtectedRoute>
            }
          />

          <Route
            element={
              <ProtectedRoute>
                <AppShell />
              </ProtectedRoute>
            }
          >
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/clock-in" element={<ClockInPage />} />
            <Route path="/people" element={<PeoplePage />} />
            <Route path="/people/:userId" element={<PersonDetailPage />} />
            <Route path="/permissions" element={<GrantPermissionsPage />} />
            <Route path="/admin-clock" element={<PlanRoute feature="on_behalf"><AdminOnBehalfPage /></PlanRoute>} />
            <Route path="/audit-log" element={<PlanRoute feature="audit"><AuditLogPage /></PlanRoute>} />
            <Route path="/sites" element={<SitesPage />} />
            <Route path="/sites/:siteId" element={<SiteDetailPage />} />
            <Route path="/workers" element={<PlanRoute feature="kiosk"><ExternalWorkersPage /></PlanRoute>} />
            <Route path="/workers/pay" element={<PlanRoute feature="kiosk"><ExternalPayPage /></PlanRoute>} />
            <Route path="/workers/pay/:runId" element={<PlanRoute feature="kiosk"><ExternalPayRunPage /></PlanRoute>} />
            <Route path="/manager" element={<ManagerConsolePage />} />
            <Route path="/attendance" element={<AttendanceLogPage />} />
            <Route path="/timesheets" element={<TimesheetsPage />} />
            <Route path="/timesheets/:timesheetId/report" element={<TimesheetReportPage />} />
            <Route path="/allowances" element={<PlanRoute feature="allowances"><AllowancesPage /></PlanRoute>} />
            <Route path="/allowances/prices" element={<PlanRoute feature="allowances"><AllowancePricesPage /></PlanRoute>} />
            <Route path="/leave" element={<PlanRoute feature="leave"><LeaveRequestsPage /></PlanRoute>} />
            <Route path="/payroll" element={<PlanRoute feature="payroll"><PayrollHomePage /></PlanRoute>} />
            <Route path="/payroll/cycles/:cycleId" element={<PlanRoute feature="payroll"><PayrollCyclePage /></PlanRoute>} />
            <Route path="/payroll/profiles" element={<PlanRoute feature="payroll"><PayrollProfilesPage /></PlanRoute>} />
            <Route path="/payroll/settings" element={<PlanRoute feature="payroll"><PayrollSettingsPage /></PlanRoute>} />
            <Route path="/payroll/requests" element={<PlanRoute feature="payroll"><PayslipRequestsPage /></PlanRoute>} />
            <Route path="/payslips" element={<PlanRoute feature="payroll"><MyPayslipsPage /></PlanRoute>} />
            <Route path="/me" element={<MyProfilePage />} />
            <Route path="/documents" element={<PlanRoute feature="documents"><DocumentsPage /></PlanRoute>} />
            {/* 2026-11-09 Media Center: announcements for everyone; publishing is checked on the server */}
            <Route path="/announcements" element={<AnnouncementsPage />} />
            <Route path="/exceptions" element={<ExceptionsPage />} />
            <Route path="/schedule" element={<SchedulePage />} />
            <Route path="/calendar" element={<CalendarPage />} />
            <Route path="/emergency-log" element={<PlanRoute feature="sos"><EmergencyLogPage /></PlanRoute>} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/daily-summary" element={<PlanRoute feature="daily_summary"><DailySummaryPage /></PlanRoute>} />
            <Route path="/settings" element={<OrganizationSettingsPage />} />
            {/* Hidden while FEATURES.integrations is off (owner 2026-10-13). */}
            <Route path="/integrations" element={FEATURES.integrations ? <IntegrationsPage /> : <Navigate to="/dashboard" replace />} />
            <Route path="/kiosk" element={<PlanRoute feature="kiosk"><KioskLauncherPage /></PlanRoute>} />
            <Route path="/help" element={<HelpPage />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </KioskLockGuard>
        </Suspense>
        </PageLoadBoundary>
      </AuthProvider>
    </BrowserRouter>
  );
}

// v2.3.44 (owner 2026-10-26): before sign-in the update notice stays at the
// top; inside the app shell it is one of the notices under the header.
const OUTSIDE_SHELL = ["/", "/welcome", "/activate", "/login", "/forgot-password", "/reset-password", "/accept-invitation", "/privacy", "/terms"];

function PublicUpdateBanner() {
  const { pathname } = useLocation();
  const outside = OUTSIDE_SHELL.includes(pathname) || pathname.startsWith("/kiosk/");
  return outside ? <UpdateAvailableBanner /> : null;
}
