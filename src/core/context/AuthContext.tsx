import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

import AuthService from "../auth/AuthService";
import UserRepository, { type CurrentUserProfile } from "../repositories/UserRepository";

interface AuthContextValue {
  loading: boolean;
  isAuthenticated: boolean;
  profile: CurrentUserProfile | null;
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

// PROSM Time - the one place session state and the caller's own
// server-verified profile (§9: "the client only reflects, never
// enforces, permission state") are held for the whole app. Every
// protected screen reads `profile` from here rather than re-fetching
// or trusting anything client-computed.
export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [profile, setProfile] = useState<CurrentUserProfile | null>(null);

  const loadProfile = useCallback(async () => {
    const result = await UserRepository.getCurrentUser();
    setProfile(result.success ? result.data : null);
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
    setIsAuthenticated(false);
  }, []);

  return (
    <AuthContext.Provider value={{ loading, isAuthenticated, profile, refreshProfile, signOut }}>
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
