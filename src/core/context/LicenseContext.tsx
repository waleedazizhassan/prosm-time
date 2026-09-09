// PROSM Time - surfaces the server's license decision to the UI (License
// Enforcement & Installation Identity phase, user-directed).
//
// It registers the installation once, then heartbeats validate-installation.
// It is a DISPLAY layer: removing this provider removes the warning, not the
// enforcement - every protected operation is refused by the server itself.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { getSupabaseClient } from "../api/supabaseClient";
import { APP_VERSION } from "../appVersion";
import { ensureInstallationIdentity, installationHeaders } from "../license/installationIdentity";
import { toLicenseSnapshot, UNKNOWN_LICENSE, type LicenseSnapshot } from "../license/licenseState";

const HEARTBEAT_MS = 6 * 60 * 60 * 1000;

interface LicenseContextValue {
  license: LicenseSnapshot;
  refresh: () => Promise<void>;
}

const LicenseContext = createContext<LicenseContextValue>({
  license: UNKNOWN_LICENSE,
  refresh: async () => {},
});

export function useLicense(): LicenseContextValue {
  return useContext(LicenseContext);
}

export function LicenseProvider({ children }: { children: ReactNode }) {
  const [license, setLicense] = useState<LicenseSnapshot>(UNKNOWN_LICENSE);
  const running = useRef(false);

  const refresh = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      const { data: sessionData } = await getSupabaseClient().auth.getSession();
      const accessToken = sessionData.session?.access_token ?? null;

      await ensureInstallationIdentity(accessToken);

      const { data, error } = await getSupabaseClient().functions.invoke("validate-installation", {
        body: { appVersion: APP_VERSION },
        headers: installationHeaders(),
      });

      if (error || !data?.success) {
        // Offline or unreachable: keep the last known state rather than
        // inventing one in either direction.
        setLicense((previous) => ({ ...previous, stale: true }));
        return;
      }

      setLicense(toLicenseSnapshot(data.data));
    } catch {
      setLicense((previous) => ({ ...previous, stale: true }));
    } finally {
      running.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), HEARTBEAT_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const value = useMemo(() => ({ license, refresh }), [license, refresh]);

  return <LicenseContext.Provider value={value}>{children}</LicenseContext.Provider>;
}
