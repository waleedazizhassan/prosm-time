import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

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

  const loadProfile = useCallback(async () => {
    const [profileResult, permissionsResult] = await Promise.all([
      UserRepository.getCurrentUser(),
      PermissionRepository.getEffectivePermissions(),
    ]);
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

    return () => {
      mounted = false;
      subscription.unsubscribe();
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
