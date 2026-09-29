import { Suspense } from "react";
import { Outlet, useLocation } from "react-router-dom";
import PageLoadBoundary from "../../components/common/PageLoadBoundary";

import Header from "./Header";
import Sidebar from "./Sidebar";
import Main from "./Main";
import InstallationStatusBanner from "./InstallationStatusBanner";
import OfflineBanner from "./OfflineBanner";
import PresenceTrackingLoop from "./PresenceTrackingLoop";
import { LayoutProvider } from "./LayoutContext";
import styles from "./AppShell.module.css";
import TrialBanner from "./TrialBanner";
import AttendanceSyncStatus from "./AttendanceSyncStatus";

// PROSM Time Implementation Master File V3.0, §30 ("Navigation must be
// explicitly designed and implemented") - the real application shell:
// Header + Sidebar + Main, mirroring PROSM Platform's own AppLayout
// structure and visual language exactly (§ visual consistency pass,
// user-directed: "It must have a consistent PROSM Header, left Sidebar
// navigation, User Menu, and Main Content area... Do not create a new
// navigation or layout style"). Wraps every protected route via
// AppRoutes - see that file's own layout-route usage.
export default function AppShell() {
  const location = useLocation();
  return (
    <LayoutProvider>
      <div className={styles.layout}>
        <InstallationStatusBanner />
        <TrialBanner />
        <OfflineBanner />
        <AttendanceSyncStatus />
        <PresenceTrackingLoop />
        <Header />
        <div className={styles.body}>
          <Sidebar />
          <Main>
            <PageLoadBoundary resetKey={location.pathname}>
              <Suspense fallback={null}>
                <Outlet />
              </Suspense>
            </PageLoadBoundary>
          </Main>
        </div>
      </div>
    </LayoutProvider>
  );
}
