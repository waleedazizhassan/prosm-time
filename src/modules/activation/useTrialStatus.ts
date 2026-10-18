import { useCallback, useEffect, useState } from "react";

import LicenseRepository, { type TrialStatus } from "../../core/repositories/LicenseRepository";
import { startupCheck } from "../../core/utils/startupCheck";

// The organisation's trial for the signed-in person (owner 2026-09-29). Read before the app
// opens: an ended trial shows the "trial ended" page instead (the server locks its data too).
export default function useTrialStatus(enabled: boolean) {
  const [status, setStatus] = useState<TrialStatus | null>(null);
  const [loading, setLoading] = useState(enabled);

  const reload = useCallback(async () => {
    // Offline, on a connection too slow to answer in time, or if the status cannot be read, the
    // app opens as before (offline attendance keeps working); the server still enforces the lock
    // on every request.
    const result = await startupCheck(() => LicenseRepository.getTrialStatus());
    setStatus(result?.success && result.data ? result.data : { isTrial: false, locked: false });
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
