import "./components/common/design-tokens.css";
import AppRoutes from "./routes/AppRoutes";
import { ThemeProvider } from "./core/context/ThemeContext";
import { CalendarProvider } from "./core/context/CalendarContext";
import ErrorBoundary from "./components/common/ErrorBoundary";
import useAutoFullscreen from "./core/hooks/useAutoFullscreen";
import useAndroidBackButton from "./core/hooks/useAndroidBackButton";

// PROSM Time Implementation Master File V3.0 - the real application
// shell, wired up as of WP-03 (Authentication & Organization). The
// WP-01 placeholder ("architecture verified, no product screens yet")
// is retired now that real screens exist.
//
// §28 - "Dark Mode is the default application appearance. The user
// can switch between Dark, Light, and System." ThemeProvider (WP-20)
// owns the real default/toggle/persistence now - it replaces this
// file's earlier fixed GUEST_DEFAULT_THEME useEffect.
export default function App() {
  useAutoFullscreen();
  useAndroidBackButton();

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <CalendarProvider>
          <AppRoutes />
        </CalendarProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
