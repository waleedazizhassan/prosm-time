import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, X } from "lucide-react";

import { useAuth } from "../../core/context/AuthContext";

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
  // owner 2026-11-16: the owner only (an employee can do nothing about a licence), and it can be closed - closed
  // stays closed for that same grace date on this device
  const { profile } = useAuth();
  const dismissKey = status ? `prosm.installationBanner.${status.state}.${status.graceEndsAt ?? ""}` : "";
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!dismissKey) return;
    try { setDismissed(localStorage.getItem(dismissKey) === "1"); } catch { setDismissed(false); }
  }, [dismissKey]);

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

  if (!profile?.isOwner || dismissed || !status || status.state === "ACTIVE" || status.state === null) return null;
  const close = () => {
    setDismissed(true);
    try { localStorage.setItem(dismissKey, "1"); } catch { /* private mode: closed for this visit */ }
  };

  const isBlocked = status.state === "BLOCKED";

  return (
    <div className={`${styles.banner} ${isBlocked ? styles.blocked : styles.grace}`}>
      <AlertTriangle size={16} />
      <span>
        {isBlocked
          ? t("installation.blocked")
          : t("installation.grace", { date: status.graceEndsAt ? formatDateOnly(status.graceEndsAt, i18n.language) : "" })}
      </span>
      <button type="button" className={styles.close} onClick={close} aria-label={t("installation.close")} title={t("installation.close")}>
        <X size={16} />
      </button>
    </div>
  );
}
