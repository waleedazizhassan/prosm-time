import { Outlet } from "react-router-dom";

import Header from "./Header";
import Sidebar from "./Sidebar";
import Main from "./Main";
import { LayoutProvider } from "./LayoutContext";
import styles from "./AppShell.module.css";

// PROSM Time Implementation Master File V3.0, §30 ("Navigation must be
// explicitly designed and implemented") - the real application shell:
// Header + Sidebar + Main, mirroring PROSM Platform's own AppLayout
// structure and visual language exactly (§ visual consistency pass,
// user-directed: "It must have a consistent PROSM Header, left Sidebar
// navigation, User Menu, and Main Content area... Do not create a new
// navigation or layout style"). Wraps every protected route via
// AppRoutes - see that file's own layout-route usage.
export default function AppShell() {
  return (
    <LayoutProvider>
      <div className={styles.layout}>
        <Header />
        <div className={styles.body}>
          <Sidebar />
          <Main>
            <Outlet />
          </Main>
        </div>
      </div>
    </LayoutProvider>
  );
}
