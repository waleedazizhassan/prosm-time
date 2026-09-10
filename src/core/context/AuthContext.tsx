import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import AuthService from "../auth/AuthService";
import UserRepository, { type CurrentUserProfile } from "../repositories/UserRepository";
import PermissionRepository from "../repositories/PermissionRepository";

interface AuthContextValue {
  loading: boolean;
  isAuthenticated: boolean;
  profile: CurrentUserProfile | null;
  permissions: string[];
  hasPermission: (permissionKey: string) => boolean;
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

// § real bug, user-reported - opening the app offline left a blank
// navy screen forever with nothing loading. Root cause: loadProfile()'s
// two network calls (auth.getUser(), the permissions RPC) had no
// timeout and no offline check, so a hung fetch with no connectivity
// left `loading` stuck `true` forever - and every route in AppRoutes
// renders null while that's true (§ live UX review, "the splash screen
// has no use, remove it entirely"), so nothing ever painted over the
// native shell's own background. This bounds the wait so the app shell
// always eventually renders, online or not.
const PROFILE_LOAD_TIMEOUT_MS = 8000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([promise, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms))]);
}

// PROSM Time - the one place session state, the caller's own
// server-verified profile, and their real effective permission set
// (§9: "the client only reflects, never enforces, permission state")
// are held for the whole app. `hasPermission` is a UI convenience for
// showing/hiding controls - every action it gates is ALSO re-checked
// server-side by its own RPC/Edge Function, so a stale or bypassed
// client check can never itself authorize anything.
export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [profile, setProfile] = useState<CurrentUserProfile | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const isAuthenticatedRef = useRef(isAuthenticated);
  isAuthenticatedRef.current = isAuthenticated;

  const loadProfile = useCallback(async () => {
    // Already known offline - the calls below would just hang until
    // they time out. Skip straight to keeping whatever profile/
    // permissions state is already held (null on first boot) rather
    // than making the user wait out the full timeout for a call that
    // can't possibly succeed right now.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return;
    }

    const result = await withTimeout(
      Promise.all([UserRepository.getCurrentUser(), PermissionRepository.getEffectivePermissions()]),
      PROFILE_LOAD_TIMEOUT_MS,
    );
    if (result === "timeout") return;

    const [profileResult, permissionsResult] = result;
    setProfile(profileResult.success ? profileResult.data : null);
    setPermissions(permissionsResult.success ? permissionsResult.data ?? [] : []);
  }, []);

  const refreshProfile = useCallback(async () => {
    await loadProfile();
  }, [loadProfile]);

  useEffect(() => {
    let mounted = true;

    AuthService.getSession().then(async (session) => {
      if (!mounted) return;
      setIsAuthenticated(Boolean(session));
      if (session) await loadProfile();
      setLoading(false);
    });

    const {
      data: { subscription },
    } = AuthService.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      setIsAuthenticated(Boolean(session));
      if (session) {
        loadProfile();
      } else {
        setProfile(null);
        setPermissions([]);
      }
    });

    // Connectivity just came back after loadProfile() skipped or timed
    // out while offline - fill in the real profile/permissions now
    // instead of leaving the user on the degraded (null) state until
    // they manually reload.
    const handleOnline = () => {
      if (mounted && isAuthenticatedRef.current) loadProfile();
    };
    window.addEventListener("online", handleOnline);

    return () => {
      mounted = false;
      subscription.unsubscribe();
      window.removeEventListener("online", handleOnline);
    };
  }, [loadProfile]);

  const signOut = useCallback(async () => {
    await AuthService.signOut();
    setProfile(null);
    setPermissions([]);
    setIsAuthenticated(false);
  }, []);

  const hasPermission = useCallback((permissionKey: string) => permissions.includes(permissionKey), [permissions]);

  return (
    <AuthContext.Provider value={{ loading, isAuthenticated, profile, permissions, hasPermission, refreshProfile, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider.");
  }
  return context;
}
