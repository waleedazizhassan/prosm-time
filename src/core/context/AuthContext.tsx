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

// § real bug, user-reported (2026-09-13) - the timeout fix above stops
// the infinite spinner, but a cold app open while offline still left
// `profile` at its initial `null` forever (loadProfile() returns
// immediately, never setting it) - every screen that needs profile.*
// to render anything real then shows nothing, the same blank result as
// the original bug, just without the hang. Real fix: persist the last
// successfully-loaded profile/permissions locally and hydrate from
// that cache immediately on boot, online or not - a real (if possibly
// a few minutes stale) screen instead of a blank one. The background
// loadProfile() call still runs and overwrites this with a fresh
// server read the moment a real connection exists.
const CACHE_KEY = "prosm_time_cached_profile_v1";

interface CachedProfileState {
  profile: CurrentUserProfile;
  permissions: string[];
}

function readCachedProfile(): CachedProfileState | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CachedProfileState;
  } catch {
    return null;
  }
}

function writeCachedProfile(state: CachedProfileState | null): void {
  try {
    if (state) localStorage.setItem(CACHE_KEY, JSON.stringify(state));
    else localStorage.removeItem(CACHE_KEY);
  } catch {
    // Private browsing / storage disabled - the cache is a convenience,
    // never a requirement, so a write failure here is silently ignored.
  }
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
    const nextProfile = profileResult.success ? profileResult.data : null;
    const nextPermissions = permissionsResult.success ? permissionsResult.data ?? [] : [];
    setProfile(nextProfile);
    setPermissions(nextPermissions);
    if (nextProfile) writeCachedProfile({ profile: nextProfile, permissions: nextPermissions });
  }, []);

  const refreshProfile = useCallback(async () => {
    await loadProfile();
  }, [loadProfile]);

  useEffect(() => {
    let mounted = true;

    // Hydrate synchronously from the last cached profile before any
    // network call resolves - this is what actually renders a real
    // screen on a cold, offline app open instead of a blank one.
    // loadProfile() below still runs and overwrites this with a fresh
    // server read the moment a real connection exists.
    const cached = readCachedProfile();
    if (cached) {
      setProfile(cached.profile);
      setPermissions(cached.permissions);
    }

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
        writeCachedProfile(null);
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
    // Privacy: never leave a signed-out user's cached profile behind
    // for the next person to boot into on a shared device.
    writeCachedProfile(null);
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
