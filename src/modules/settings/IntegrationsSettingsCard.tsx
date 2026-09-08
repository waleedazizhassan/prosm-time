import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Check } from "lucide-react";

import ApiKeyRepository, { type ApiKeySummary } from "../../core/repositories/ApiKeyRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import { formatDateTime } from "../../core/utils/formatDate";

import Card from "../../components/common/Card";
import Input from "../../components/common/Input";
import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";
import Modal from "../../components/common/Modal";

// PROSM Time - § user-directed: a real integration key so sibling
// PROSM products (PROSM Projects first) can pull verified attendance
// instead of hand-typing it, over export-attendance (20260908190000).
// Read-only scope only - this key can never write anything back into
// PROSM Time. The plaintext value is shown exactly once, right after
// creation, in its own confirmation modal - list() below only ever
// returns metadata afterward, matching the platform's own product API
// key posture (never retrievable again, only revocable).
export default function IntegrationsSettingsCard() {
  const { t, i18n } = useTranslation("settings");

  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [revokingId, setRevokingId] = useState<string | null>(null);
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

  const handleCreate = async () => {
    if (!name.trim()) return;
    setCreating(true);
    setError("");
    const result = await ApiKeyRepository.generate(name.trim());
    setCreating(false);
    if (!result.success || !result.data) {
      setError(humanizeBackendError(result.message, t) ?? t("integrations.createError"));
      return;
    }
    setNewKeyValue(result.data.apiKey);
    setName("");
    load();
  };

  const handleRevoke = async (keyId: string) => {
    setRevokingId(keyId);
    setError("");
    const result = await ApiKeyRepository.revoke(keyId);
    setRevokingId(null);
    if (!result.success) {
      setError(humanizeBackendError(result.message, t) ?? t("integrations.revokeError"));
      return;
    }
    load();
  };

  const handleCopy = async () => {
    if (!newKeyValue) return;
    try {
      await navigator.clipboard.writeText(newKeyValue);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can fail (permissions/insecure context) - the
      // key stays selectable in the field either way, never a dead end.
    }
  };

  const activeKeys = keys.filter((key) => !key.revokedAt);

  if (loading) return null;

  return (
    <Card title={t("integrations.title")}>
      <p style={{ margin: "0 0 var(--space-3)", fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{t("integrations.hint")}</p>

      {activeKeys.length > 0 ? (
        <div style={{ marginBottom: "var(--space-4)" }}>
          {activeKeys.map((key) => (
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
              <div>
                <p style={{ margin: 0, fontSize: "var(--font-sm)", fontWeight: "var(--font-weight-medium)" }}>{key.name}</p>
                <p style={{ margin: "2px 0 0", fontSize: "var(--font-xs)", color: "var(--text-secondary)", fontFamily: "monospace" }}>
                  {key.keyPrefix}…
                  {key.lastUsedAt ? ` · ${t("integrations.lastUsed", { time: formatDateTime(key.lastUsedAt, i18n.language) })}` : ` · ${t("integrations.neverUsed")}`}
                </p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => handleRevoke(key.id)} loading={revokingId === key.id}>
                {t("integrations.revokeAction")}
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)", marginBottom: "var(--space-4)" }}>{t("integrations.empty")}</p>
      )}

      <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "flex-end", flexWrap: "wrap" }}>
        <div style={{ maxWidth: 280, flex: 1 }}>
          <Input
            label={t("integrations.nameLabel")}
            name="apiKeyName"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={creating}
            placeholder={t("integrations.namePlaceholder")}
          />
        </div>
        <Button onClick={handleCreate} loading={creating} disabled={!name.trim()}>
          {t("integrations.createAction")}
        </Button>
      </div>

      <ErrorText>{error}</ErrorText>

      <Modal isOpen={newKeyValue !== null} onClose={() => setNewKeyValue(null)} title={t("integrations.newKeyTitle")}>
        <p style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)", marginBottom: "var(--space-3)" }}>{t("integrations.newKeyWarning")}</p>
        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
          <input
            readOnly
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
          <Button size="sm" variant="ghost" onClick={handleCopy}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </Button>
        </div>
      </Modal>
    </Card>
  );
}
