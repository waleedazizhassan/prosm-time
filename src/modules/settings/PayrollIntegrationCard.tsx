import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

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

type ProviderKey = "xero" | "gusto";

const PROVIDERS: Record<ProviderKey, PayrollProviderRepository> = {
  xero: XeroRepository,
  gusto: GustoRepository,
};

// PROSM Time - unified Payroll Integration selector, replacing the
// earlier standalone QuickBooksSettingsCard.tsx now that Xero and
// Gusto exist as additional, equally real (if currently dormant, see
// each provider's own Edge Function header comments) options -
// user-directed 2026-09-09: "ready as options in a selection list."
// Each provider's own backing schema/RPCs/Edge Functions stay fully
// separate (xero_connections/gusto_connections are independent
// tables, matching this codebase's own established "dedicated table
// per domain" convention) - this component is purely a shared UI
// shell over these structurally-identical repositories.
//
// QuickBooks removed entirely 2026-09-15 (user-directed - PROSM
// Finance now computes payroll natively via its own PROSM Time API-key
// bridge, so no external payroll software is needed at all). Xero/
// Gusto are untouched - they were never the subject of that
// instruction and stay exactly as dormant/hidden as before (this whole
// card is still not rendered anywhere - see OrganizationSettingsPage's
// own "hide it, not delete it" comment).
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

// § user-directed 2026-09-09: Xero and Gusto stay fully built
// (schema/RPCs/Edge Functions untouched, PROVIDERS map below still
// carries both) but are hidden from this UI for now - neither has real
// credentials configured. QuickBooks (the one that did) was removed
// entirely 2026-09-15 - see this file's own header comment - so
// VISIBLE_PROVIDERS is empty until Xero or Gusto is ever made real.
// Restoring one later is a one-line change: add its key to
// VISIBLE_PROVIDERS - no backend work needed. This whole card is still
// not rendered anywhere regardless (OrganizationSettingsPage.tsx).
const PROVIDER_ORDER: ProviderKey[] = ["xero", "gusto"];
const VISIBLE_PROVIDERS: ProviderKey[] = [];

export default function PayrollIntegrationCard() {
  const { t } = useTranslation("settings");
  const [selected, setSelected] = useState<ProviderKey | null>(VISIBLE_PROVIDERS[0] ?? null);

  if (!selected) return null;

  return (
    <Card title={t("payroll.title")}>
      {VISIBLE_PROVIDERS.length > 1 ? (
        <div style={{ marginBottom: "var(--space-3)", maxWidth: 280 }}>
          <Select
            label={t("payroll.providerLabel")}
            name="payrollProvider"
            value={selected}
            onChange={(event) => setSelected(event.target.value as ProviderKey)}
            options={PROVIDER_ORDER.filter((key) => VISIBLE_PROVIDERS.includes(key)).map((key) => ({ value: key, label: t(`payroll.providers.${key}`) }))}
          />
        </div>
      ) : null}
      <ProviderPanel key={selected} provider={PROVIDERS[selected]} providerKey={selected} />
    </Card>
  );
}
