import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import QuickBooksRepository from "../../core/repositories/QuickBooksRepository";
import XeroRepository from "../../core/repositories/XeroRepository";
import GustoRepository from "../../core/repositories/GustoRepository";
import { formatDateTime } from "../../core/utils/formatDate";

import Card from "../../components/common/Card";
import Select from "../../components/common/Select";
import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";

interface PayrollStatus {
  connected: boolean;
  companyName: string | null;
  lastSyncedAt: string | null;
  lastSyncSummary: { synced: number; skippedNoEmployee: number; failed: number; unmatchedEmails: string[] } | null;
}

interface PayrollServiceResult<T> {
  success: boolean;
  message: string | null;
  data: T | null;
  code?: string | null;
}

interface PayrollProviderRepository {
  getStatus(): Promise<PayrollServiceResult<PayrollStatus>>;
  startConnection(): Promise<PayrollServiceResult<{ authorizeUrl: string }>>;
  disconnect(): Promise<PayrollServiceResult<null>>;
  syncNow(): Promise<PayrollServiceResult<{ synced: number; skippedNoEmployee: number; failed: number; unmatchedEmails: string[] }>>;
}

type ProviderKey = "quickbooks" | "xero" | "gusto";

const PROVIDERS: Record<ProviderKey, PayrollProviderRepository> = {
  quickbooks: QuickBooksRepository,
  xero: XeroRepository,
  gusto: GustoRepository,
};

// PROSM Time - unified Payroll Integration selector, replacing the
// earlier standalone QuickBooksSettingsCard.tsx now that Xero and
// Gusto exist as additional, equally real (if currently dormant, see
// each provider's own Edge Function header comments) options -
// user-directed 2026-09-09: "ready as options in a selection list."
// Each provider's own backing schema/RPCs/Edge Functions stay fully
// separate (xero_connections/gusto_connections/quickbooks_connections
// are independent tables, matching this codebase's own established
// "dedicated table per domain" convention) - this component is purely
// a shared UI shell over three structurally-identical repositories.
function ProviderPanel({ provider, providerKey }: { provider: PayrollProviderRepository; providerKey: ProviderKey }) {
  const { t, i18n } = useTranslation("settings");

  const [status, setStatus] = useState<PayrollStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [notConfigured, setNotConfigured] = useState(false);

  const load = () => {
    setLoading(true);
    provider.getStatus().then((result) => {
      setStatus(result.success ? result.data : null);
      setLoading(false);
    });
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerKey]);

  // Refresh status when the user comes back to this tab after
  // finishing (or abandoning) the provider's own consent screen in the
  // tab Connect opened - the OAuth code always lands on a server-side
  // Edge Function, never back in this SPA.
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerKey]);

  const handleConnect = async () => {
    setConnecting(true);
    setError("");
    setNotConfigured(false);
    const result = await provider.startConnection();
    setConnecting(false);
    if (!result.success || !result.data) {
      if (result.code === "NOT_CONFIGURED") {
        setNotConfigured(true);
      } else {
        setError(result.message ?? t(`${providerKey}.connectError`));
      }
      return;
    }
    window.open(result.data.authorizeUrl, "_blank", "noopener,noreferrer");
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    setError("");
    const result = await provider.disconnect();
    setDisconnecting(false);
    if (!result.success) {
      setError(result.message ?? t(`${providerKey}.disconnectError`));
      return;
    }
    load();
  };

  const handleSync = async () => {
    setSyncing(true);
    setError("");
    const result = await provider.syncNow();
    setSyncing(false);
    if (!result.success) {
      setError(result.message ?? t(`${providerKey}.syncError`));
      return;
    }
    load();
  };

  if (loading) return null;

  return (
    <div>
      <p style={{ margin: "0 0 var(--space-3)", fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{t(`${providerKey}.hint`)}</p>

      {status?.connected ? (
        <div style={{ marginBottom: "var(--space-2)" }}>
          <p style={{ margin: 0, fontSize: "var(--font-sm)", fontWeight: "var(--font-weight-medium)" }}>
            {t(`${providerKey}.connectedTo`, { company: status.companyName ?? t(`${providerKey}.unnamedCompany`) })}
          </p>
          <p style={{ margin: "4px 0 0", fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
            {status.lastSyncedAt ? t(`${providerKey}.lastSynced`, { time: formatDateTime(status.lastSyncedAt, i18n.language) }) : t(`${providerKey}.neverSynced`)}
          </p>
          {status.lastSyncSummary && (
            <p style={{ margin: "4px 0 0", fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
              {t(`${providerKey}.summary`, {
                synced: status.lastSyncSummary.synced,
                skipped: status.lastSyncSummary.skippedNoEmployee,
                failed: status.lastSyncSummary.failed,
              })}
            </p>
          )}
          {status.lastSyncSummary && status.lastSyncSummary.unmatchedEmails.length > 0 && (
            <p style={{ margin: "4px 0 0", fontSize: "var(--font-xs)", color: "var(--warning-text, #b3261e)" }}>
              {t(`${providerKey}.unmatchedEmails`, { emails: status.lastSyncSummary.unmatchedEmails.join(", ") })}
            </p>
          )}

          <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
            <Button size="sm" onClick={handleSync} loading={syncing}>
              {t(`${providerKey}.syncAction`)}
            </Button>
            <Button size="sm" variant="ghost" onClick={handleDisconnect} loading={disconnecting}>
              {t(`${providerKey}.disconnectAction`)}
            </Button>
          </div>
        </div>
      ) : (
        <div style={{ marginBottom: "var(--space-2)" }}>
          <p style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)", marginBottom: "var(--space-3)" }}>{t(`${providerKey}.notConnected`)}</p>
          {notConfigured ? (
            <p style={{ fontSize: "var(--font-sm)", color: "var(--warning-text, #b3261e)", marginBottom: "var(--space-3)" }}>{t("payroll.notConfigured")}</p>
          ) : (
            <Button size="sm" onClick={handleConnect} loading={connecting}>
              {t(`${providerKey}.connectAction`)}
            </Button>
          )}
        </div>
      )}

      <ErrorText>{error}</ErrorText>
    </div>
  );
}

export default function PayrollIntegrationCard() {
  const { t } = useTranslation("settings");
  const [selected, setSelected] = useState<ProviderKey>("quickbooks");

  return (
    <Card title={t("payroll.title")}>
      <div style={{ marginBottom: "var(--space-3)", maxWidth: 280 }}>
        <Select
          label={t("payroll.providerLabel")}
          name="payrollProvider"
          value={selected}
          onChange={(event) => setSelected(event.target.value as ProviderKey)}
          options={[
            { value: "quickbooks", label: t("payroll.providers.quickbooks") },
            { value: "xero", label: t("payroll.providers.xero") },
            { value: "gusto", label: t("payroll.providers.gusto") },
          ]}
        />
      </div>
      <ProviderPanel key={selected} provider={PROVIDERS[selected]} providerKey={selected} />
    </Card>
  );
}
