import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

// PROSM Time Implementation Master File V3.0, WP-20/§28 - "Dark Mode
// is the default application appearance. The user can switch between
// Dark, Light, and System/Default device preference where supported.
// Behavior is consistent across Web and Mobile." App.tsx's own
// GUEST_DEFAULT_THEME (WP-03) fixed "dark" via [data-theme] and
// explicitly deferred "the full Light/Dark/System toggle (with
// persistence)" to this WP - this is that real toggle, replacing the
// fixed default rather than sitting alongside it.
export type ThemeMode = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "prosm_time_theme";
const DEFAULT_THEME: ThemeMode = "dark";

interface ThemeContextValue {
  theme: ThemeMode;
  resolvedTheme: "light" | "dark";
  setTheme: (theme: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function readStoredTheme(): ThemeMode {
  if (typeof window === "undefined") return DEFAULT_THEME;
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : DEFAULT_THEME;
}

function resolveSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>(readStoredTheme);
  const [systemTheme, setSystemTheme] = useState<"light" | "dark">(resolveSystemTheme);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => setSystemTheme(media.matches ? "dark" : "light");
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  const resolvedTheme = theme === "system" ? systemTheme : theme;

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  const setTheme = (next: ThemeMode) => {
    setThemeState(next);
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  };

  const value = useMemo(() => ({ theme, resolvedTheme, setTheme }), [theme, resolvedTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
