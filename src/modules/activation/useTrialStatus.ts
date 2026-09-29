import { useCallback, useEffect, useState } from "react";

import LicenseRepository, { type TrialStatus } from "../../core/repositories/LicenseRepository";

// The organisation's trial for the signed-in person (owner 2026-09-29). Read before the app
// opens: an ended trial shows the "trial ended" page instead (the server locks its data too).
export default function useTrialStatus(enabled: boolean) {
  const [status, setStatus] = useState<TrialStatus | null>(null);
  const [loading, setLoading] = useState(enabled);

  const reload = useCallback(async () => {
    const result = await LicenseRepository.getTrialStatus();
    // Offline, or if the status cannot be read, the app opens as before (offline attendance keeps
    // working); the server still enforces the lock on every request.
    setStatus(result.success && result.data ? result.data : { isTrial: false, locked: false });
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void reload();
  }, [enabled, reload]);

  return { status, loading, reload };
}
