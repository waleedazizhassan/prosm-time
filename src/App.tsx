import { useEffect } from "react";
import "./components/common/design-tokens.css";
import AppRoutes from "./routes/AppRoutes";

// PROSM Time Implementation Master File V3.0, §28 - "Dark Mode is the
// default application appearance." Mirrors PROSM Platform's own
// ThemeContext GUEST_DEFAULT_THEME exactly: a fixed "dark" applied via
// [data-theme] on the root element, never silently following the OS.
// The full Light/Dark/System toggle (with persistence) is WP-20's own
// scope (Theming & Visual Identity) - this is just the real default,
// applied the same way the toggle itself will later override it.
const GUEST_DEFAULT_THEME = "dark";

// PROSM Time Implementation Master File V3.0 - the real application
// shell, wired up as of WP-03 (Authentication & Organization). The
// WP-01 placeholder ("architecture verified, no product screens yet")
// is retired now that real screens exist.
export default function App() {
  useEffect(() => {
    document.documentElement.dataset.theme = GUEST_DEFAULT_THEME;
  }, []);

  return <AppRoutes />;
}
