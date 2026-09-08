import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import QuickBooksRepository, { type QuickBooksStatus } from "../../core/repositories/QuickBooksRepository";
import { formatDateTime } from "../../core/utils/formatDate";

import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";

// PROSM Time - the 3rd competitive gap (payroll-system integration),
// QuickBooks Online chosen as the first target (see
// prosm_time_payroll_integration_deferred in project memory). Connect
// opens Intuit's own consent screen in a new tab - the OAuth
// authorization code lands on quickbooks-oauth-callback, a server-side
// Edge Function, never back in this SPA - so this card only ever polls
// getStatus() afterward rather than handling any redirect itself.
export default function QuickBooksSettingsCard() {
  const { t, i18n } = useTranslation("settings");

  const [status, setStatus] = useState<QuickBooksStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");

  const load = () => {
    setLoading(true);
    QuickBooksRepository.getStatus().then((result) => {
      setStatus(result.success ? result.data : null);
      setLoading(false);
    });
  };

  useEffect(() => {
    load();
  }, []);

  // Refresh status when the user comes back to this tab after
  // finishing (or abandoning) the Intuit consent screen in the tab
  // Connect opened.
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const handleConnect = async () => {
    setConnecting(true);
    setError("");
    const result = await QuickBooksRepository.startConnection();
    setConnecting(false);
    if (!result.success || !result.data) {
      setError(result.message ?? t("quickbooks.connectError"));
      return;
    }
    window.open(result.data.authorizeUrl, "_blank", "noopener,noreferrer");
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    setError("");
    const result = await QuickBooksRepository.disconnect();
    setDisconnecting(false);
    if (!result.success) {
      setError(result.message ?? t("quickbooks.disconnectError"));
      return;
    }
    load();
  };

  const handleSync = async () => {
    setSyncing(true);
    setError("");
    const result = await QuickBooksRepository.syncNow();
    setSyncing(false);
    if (!result.success) {
      setError(result.message ?? t("quickbooks.syncError"));
      return;
    }
    load();
  };

  if (loading) return null;

  return (
    <Card title={t("quickbooks.title")}>
      <p style={{ margin: "0 0 var(--space-3)", fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{t("quickbooks.hint")}</p>

      {status?.connected ? (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <p style={{ margin: 0, fontSize: "var(--font-sm)", fontWeight: "var(--font-weight-medium)" }}>
            {t("quickbooks.connectedTo", { company: status.companyName ?? t("quickbooks.unnamedCompany") })}
          </p>
          <p style={{ margin: "4px 0 0", fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
            {status.lastSyncedAt
              ? t("quickbooks.lastSynced", { time: formatDateTime(status.lastSyncedAt, i18n.language) })
              : t("quickbooks.neverSynced")}
          </p>
          {status.lastSyncSummary && (
            <p style={{ margin: "4px 0 0", fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
              {t("quickbooks.summary", {
                synced: status.lastSyncSummary.synced,
                skipped: status.lastSyncSummary.skippedNoEmployee,
                failed: status.lastSyncSummary.failed,
              })}
            </p>
          )}
          {status.lastSyncSummary && status.lastSyncSummary.unmatchedEmails.length > 0 && (
            <p style={{ margin: "4px 0 0", fontSize: "var(--font-xs)", color: "var(--warning-text, #b3261e)" }}>
              {t("quickbooks.unmatchedEmails", { emails: status.lastSyncSummary.unmatchedEmails.join(", ") })}
            </p>
          )}

          <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
            <Button size="sm" onClick={handleSync} loading={syncing}>
              {t("quickbooks.syncAction")}
            </Button>
            <Button size="sm" variant="ghost" onClick={handleDisconnect} loading={disconnecting}>
              {t("quickbooks.disconnectAction")}
            </Button>
          </div>
        </div>
      ) : (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <p style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)", marginBottom: "var(--space-3)" }}>{t("quickbooks.notConnected")}</p>
          <Button size="sm" onClick={handleConnect} loading={connecting}>
            {t("quickbooks.connectAction")}
          </Button>
        </div>
      )}

      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
