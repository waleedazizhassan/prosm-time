// PROSM Time - update awareness provider (Finalization & Release Pipeline
// phase, user-directed).
//
// Checks the published release manifest on start and every six hours. It is
// purely informational: it can show a notice and open the official download
// page, nothing else.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { APP_VERSION } from "../appVersion";
import {
  detectPlatform,
  evaluateUpdate,
  fetchManifest,
  isSnoozed,
  snoozeUpdate,
  type UpdateAvailability,
} from "../update/updateChannel";

const CHECK_MS = 6 * 60 * 60 * 1000;

interface UpdateContextValue {
  update: UpdateAvailability | null;
  dismiss: () => void;
  check: () => Promise<void>;
}

const UpdateContext = createContext<UpdateContextValue>({
  update: null,
  dismiss: () => {},
  check: async () => {},
});

export function useUpdate(): UpdateContextValue {
  return useContext(UpdateContext);
}

export function UpdateProvider({ children }: { children: ReactNode }) {
  const [update, setUpdate] = useState<UpdateAvailability | null>(null);

  const check = useCallback(async () => {
    const manifest = await fetchManifest();
    const available = evaluateUpdate(manifest, APP_VERSION, detectPlatform());
    if (available && isSnoozed(available.newVersion)) {
      setUpdate(null);
      return;
    }
    setUpdate(available);
  }, []);

  const dismiss = useCallback(() => {
    setUpdate((current) => {
      if (current) snoozeUpdate(current.newVersion, current.security);
      return null;
    });
  }, []);

  useEffect(() => {
    void check();
    const timer = window.setInterval(() => void check(), CHECK_MS);
    return () => window.clearInterval(timer);
  }, [check]);

  const value = useMemo(() => ({ update, dismiss, check }), [update, dismiss, check]);

  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}
