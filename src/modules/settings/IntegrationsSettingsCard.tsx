import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Check } from "lucide-react";

import ApiKeyRepository, {
  API_SCOPES,
  apiBaseUrl,
  type ApiKeyEnvironment,
  type ApiKeyScope,
  type ApiKeySummary,
} from "../../core/repositories/ApiKeyRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import { formatDateTime } from "../../core/utils/formatDate";

import Card from "../../components/common/Card";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";
import Modal from "../../components/common/Modal";
import HintText from "../../components/common/HintText";
import FieldRow from "../../components/common/FieldRow";

// 2026-11-08 general integration API: any system (an ERP, an accounting or HR product, a BI
// tool) reads through api-v1 with a key that holds only the scopes it needs. Read-only - a key
// never writes into PROSM Time. The plaintext is shown once, in its own modal; afterwards only
// the prefix is kept. i18next uses ':' as the namespace separator, so scopes map to
// colon-free label keys.
const SCOPE_LABEL_KEYS: Record<ApiKeyScope, string> = {
  "employees:read": "integrations.scope.employeesRead",
  "employees:read_sensitive": "integrations.scope.employeesSensitive",
  "sites:read": "integrations.scope.sitesRead",
  "attendance:read": "integrations.scope.attendanceRead",
  "attendance:write": "integrations.scope.attendanceWrite",
  "shifts:read": "integrations.scope.shiftsRead",
  "leaves:read": "integrations.scope.leavesRead",
  "payroll:read": "integrations.scope.payrollRead",
};
const EXPIRY_DAYS = ["0", "30", "90", "365"] as const;

const chip = {
  display: "inline-block",
  padding: "1px 8px",
  marginInlineEnd: 4,
  marginTop: 4,
  borderRadius: 999,
  fontSize: "var(--font-xs)",
  background: "var(--surface-hover)",
  color: "var(--text-secondary)",
} as const;

export default function IntegrationsSettingsCard() {
  const { t, i18n } = useTranslation("settings");

  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiKeyScope[]>(["attendance:read"]);
  const [expiryDays, setExpiryDays] = useState<string>("365");
  const [environment, setEnvironment] = useState<ApiKeyEnvironment>("live");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<ApiKeySummary | null>(null);
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = () => {
    setLoading(true);
    ApiKeyRepository.list().then((result) => {
      setKeys(result.success ? result.data ?? [] : []);
      setLoading(false);
    });
  };

  useEffect(() => {
    load();
  }, []);

  const toggleScope = (scope: ApiKeyScope) => {
    setScopes((current) => {
      const next = current.includes(scope) ? current.filter((value) => value !== scope) : [...current, scope];
      // contact data is an addition to the employee list, never on its own
      if (scope === "employees:read_sensitive" && next.includes(scope) && !next.includes("employees:read")) next.push("employees:read");
      if (scope === "employees:read" && !next.includes(scope)) return next.filter((value) => value !== "employees:read_sensitive");
      return next;
    });
  };

  const handleCreate = async () => {
    if (!name.trim() || scopes.length === 0) return;
    setCreating(true);
    setError("");
    const days = Number(expiryDays);
    const result = await ApiKeyRepository.generate({
      name: name.trim(),
      scopes,
      expiresAt: days > 0 ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() : null,
      environment,
    });
    setCreating(false);
    if (!result.success || !result.data) {
      setError(humanizeBackendError(result.message, t) ?? t("integrations.createError"));
      return;
    }
    setNewKeyValue(result.data.apiKey);
    setName("");
    setScopes(["attendance:read"]);
    load();
  };

  const handleRevoke = async (keyId: string) => {
    setRevokingId(keyId);
    setError("");
    const result = await ApiKeyRepository.revoke(keyId);
    setRevokingId(null);
    setConfirmRevoke(null);
    if (!result.success) {
      setError(humanizeBackendError(result.message, t) ?? t("integrations.revokeError"));
      return;
    }
    load();
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // the value stays selectable in the field either way
    }
  };

  const activeKeys = keys.filter((key) => !key.revokedAt);

  if (loading) return null;

  return (
    <Card title={t("integrations.title")}>
      <HintText>{t("integrations.hint")}</HintText>
      <p style={{ margin: "0 0 var(--space-3)", fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
        {t("integrations.endpoint")} <code dir="ltr" style={{ fontFamily: "monospace" }}>{apiBaseUrl()}</code>
      </p>

      {activeKeys.length > 0 ? (
        <div style={{ marginBottom: "var(--space-4)" }}>
          {activeKeys.map((key) => {
            const expired = key.expiresAt !== null && new Date(key.expiresAt).getTime() <= Date.now();
            return (
              <div
                key={key.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "var(--space-3)",
                  padding: "var(--space-2) 0",
                  borderTop: "1px solid var(--border-light)",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <p style={{ margin: 0, fontSize: "var(--font-sm)", fontWeight: "var(--font-weight-medium)" }}>
                    {key.name}
                    <span style={{ ...chip, marginInlineStart: 6 }}>{t(`integrations.environment.${key.environment}`)}</span>
                    {expired ? <span style={{ ...chip, color: "var(--color-danger, #b42318)" }}>{t("integrations.expired")}</span> : null}
                  </p>
                  <div>
                    {key.scopes.map((scope) => (
                      <span key={scope} style={chip}>
                        {t(SCOPE_LABEL_KEYS[scope] ?? scope)}
                      </span>
                    ))}
                  </div>
                  <p dir="auto" style={{ margin: "4px 0 0", fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
                    <span style={{ fontFamily: "monospace" }} dir="ltr">
                      {key.keyPrefix}…
                    </span>
                    {" · "}
                    {key.lastUsedAt ? t("integrations.lastUsed", { time: formatDateTime(key.lastUsedAt, i18n.language) }) : t("integrations.neverUsed")}
                    {" · "}
                    {t("integrations.requests7d", { n: key.requests7d })}
                    {" · "}
                    {key.expiresAt ? t("integrations.expiresOn", { time: formatDateTime(key.expiresAt, i18n.language) }) : t("integrations.noExpiry")}
                  </p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setConfirmRevoke(key)} loading={revokingId === key.id}>
                  {t("integrations.revokeAction")}
                </Button>
              </div>
            );
          })}
        </div>
      ) : (
        <HintText>{t("integrations.empty")}</HintText>
      )}

      <FieldRow style={{ gap: "var(--space-2)", flexWrap: "wrap" }}>
        <div style={{ maxWidth: 280, flex: 1, minWidth: 200 }}>
          <Input
            label={t("integrations.nameLabel")}
            name="apiKeyName"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={creating}
            placeholder={t("integrations.namePlaceholder")}
          />
        </div>
        <div style={{ minWidth: 160 }}>
          <Select
            label={t("integrations.expiryLabel")}
            name="apiKeyExpiry"
            value={expiryDays}
            onChange={(event) => setExpiryDays(event.target.value)}
            disabled={creating}
            options={EXPIRY_DAYS.map((days) => ({ value: days, label: days === "0" ? t("integrations.noExpiry") : t("integrations.expiryDays", { n: Number(days) }) }))}
          />
        </div>
        <div style={{ minWidth: 140 }}>
          <Select
            label={t("integrations.environmentLabel")}
            name="apiKeyEnvironment"
            value={environment}
            onChange={(event) => setEnvironment(event.target.value as ApiKeyEnvironment)}
            disabled={creating}
            options={[
              { value: "live", label: t("integrations.environment.live") },
              { value: "test", label: t("integrations.environment.test") },
            ]}
          />
        </div>
      </FieldRow>

      <fieldset style={{ border: "none", padding: 0, margin: "var(--space-3) 0" }}>
        <legend style={{ fontSize: "var(--font-sm)", fontWeight: "var(--font-weight-medium)", marginBottom: "var(--space-2)" }}>{t("integrations.scopeLabel")}</legend>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "var(--space-2)" }}>
          {API_SCOPES.map((scope) => (
            <label key={scope} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: "var(--font-sm)" }}>
              <input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggleScope(scope)} disabled={creating} />
              {t(SCOPE_LABEL_KEYS[scope])}
            </label>
          ))}
        </div>
      </fieldset>

      <Button onClick={handleCreate} loading={creating} disabled={!name.trim() || scopes.length === 0}>
        {t("integrations.createAction")}
      </Button>

      <ErrorText>{error}</ErrorText>

      <Modal isOpen={confirmRevoke !== null} onClose={() => setConfirmRevoke(null)} title={t("integrations.revokeTitle")}>
        <HintText>{t("integrations.revokeWarning", { name: confirmRevoke?.name ?? "" })}</HintText>
        <div style={{ display: "flex", gap: "var(--space-2)", justifyContent: "flex-end" }}>
          <Button variant="ghost" onClick={() => setConfirmRevoke(null)}>
            {t("integrations.cancel")}
          </Button>
          <Button onClick={() => confirmRevoke && handleRevoke(confirmRevoke.id)} loading={revokingId !== null}>
            {t("integrations.revokeAction")}
          </Button>
        </div>
      </Modal>

      <Modal isOpen={newKeyValue !== null} onClose={() => setNewKeyValue(null)} title={t("integrations.newKeyTitle")}>
        <HintText>{t("integrations.newKeyWarning")}</HintText>
        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
          <input
            readOnly
            dir="ltr"
            value={newKeyValue ?? ""}
            onFocus={(event) => event.target.select()}
            style={{
              flex: 1,
              fontFamily: "monospace",
              fontSize: "var(--font-xs)",
              padding: "var(--space-2)",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--border-light)",
              background: "var(--surface-hover)",
              color: "var(--text-primary)",
            }}
          />
          <Button size="sm" variant="ghost" onClick={() => newKeyValue && copy(newKeyValue)}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </Button>
        </div>
      </Modal>
    </Card>
  );
}
