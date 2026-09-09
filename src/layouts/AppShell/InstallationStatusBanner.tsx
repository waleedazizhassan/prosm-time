import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";

import LicenseRepository, { type InstallationStatus } from "../../core/repositories/LicenseRepository";
import { formatDateOnly } from "../../core/utils/formatDate";
import styles from "./InstallationStatusBanner.module.css";

const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // matches refresh-license-status's own established cadence

// PROSM Platform Anti-Crack & Unauthorized Installation spec
// (user-directed, centralized in Platform Management) - point 8's
// "professional message" for GRACE/BLOCKED. Deliberately does not gate
// any protected action itself (foundation-only pass); it only informs.
// Syncs once on mount (registering this installation if it hasn't been
// already) and periodically thereafter - matches
// refresh-license-status's own already-established polling cadence.
export default function InstallationStatusBanner() {
  const { t, i18n } = useTranslation("shell");
  const [status, setStatus] = useState<InstallationStatus | null>(null);

  useEffect(() => {
    let cancelled = false;

    const sync = async () => {
      const result = await LicenseRepository.syncInstallationIdentity();
      if (cancelled) return;
      if (result.success) {
        const statusResult = await LicenseRepository.getInstallationStatus();
        if (!cancelled && statusResult.success) setStatus(statusResult.data);
      }
    };

    sync();
    const interval = setInterval(sync, SYNC_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (!status || status.state === "ACTIVE" || status.state === null) return null;

  const isBlocked = status.state === "BLOCKED";

  return (
    <div className={`${styles.banner} ${isBlocked ? styles.blocked : styles.grace}`}>
      <AlertTriangle size={16} />
      <span>
        {isBlocked
          ? t("installation.blocked")
          : t("installation.grace", { date: status.graceEndsAt ? formatDateOnly(status.graceEndsAt, i18n.language) : "" })}
      </span>
    </div>
  );
}
