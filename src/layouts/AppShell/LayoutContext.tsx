import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

interface LayoutContextValue {
  sidebarCollapsed: boolean;
  toggleSidebarCollapsed: () => void;
  mobileSidebarOpen: boolean;
  openMobileSidebar: () => void;
  closeMobileSidebar: () => void;
  userMenuOpen: boolean;
  toggleUserMenu: () => void;
  closeUserMenu: () => void;
}

const LayoutContext = createContext<LayoutContextValue | undefined>(undefined);

const COLLAPSE_STORAGE_KEY = "prosm_time_sidebar_collapsed";

// PROSM Time - a lighter port of PROSM Platform's own LayoutProvider
// (§ visual consistency pass, shell): just the state this shell's
// Header/Sidebar/UserMenu actually need (collapse-to-rail, mobile
// off-canvas drawer, user menu open/close) - not that provider's own
// AI/Radio/Email/QuickActions concerns, which don't exist in this
// product yet.
export function LayoutProvider({ children }: { children: ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [location.pathname]);

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((previous) => {
      const next = !previous;
      try {
        localStorage.setItem(COLLAPSE_STORAGE_KEY, String(next));
      } catch {
        // Best-effort persistence only - a private window or blocked
        // storage must not break the toggle itself.
      }
      return next;
    });
  }, []);

  const openMobileSidebar = useCallback(() => setMobileSidebarOpen(true), []);
  const closeMobileSidebar = useCallback(() => setMobileSidebarOpen(false), []);
  const toggleUserMenu = useCallback(() => setUserMenuOpen((previous) => !previous), []);
  const closeUserMenu = useCallback(() => setUserMenuOpen(false), []);

  return (
    <LayoutContext.Provider
      value={{
        sidebarCollapsed,
        toggleSidebarCollapsed,
        mobileSidebarOpen,
        openMobileSidebar,
        closeMobileSidebar,
        userMenuOpen,
        toggleUserMenu,
        closeUserMenu,
      }}
    >
      {children}
    </LayoutContext.Provider>
  );
}

export function useAppLayout(): LayoutContextValue {
  const context = useContext(LayoutContext);
  if (!context) {
    throw new Error("useAppLayout must be used within a LayoutProvider.");
  }
  return context;
}
