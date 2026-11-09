import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import DatabaseManager from "../../core/database/DatabaseManager";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import { formatDateTime } from "../../core/utils/formatDate";

import Card from "../../components/common/Card";
import Input from "../../components/common/Input";
import Button from "../../components/common/Button";
import Modal from "../../components/common/Modal";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";

const EVENTS = ["employee.created", "employee.updated", "employee.deactivated", "attendance.clock_in", "attendance.clock_out", "leave.requested", "leave.approved", "leave.rejected", "leave.cancelled"] as const;
// i18next reads ':' and '.' as separators, so each event maps to a plain key
const eventKey = (event: string) => `integrations.webhooks.event.${event.replace(".", "_")}`;

interface Endpoint {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  secretPrefix: string;
  environment: "live" | "test";
  active: boolean;
  disabledReason: string | null;
  delivered7d: number;
  dead7d: number;
  pending: number;
}

interface Delivery {
  id: string;
  event: string;
  status: "pending" | "sending" | "delivered" | "dead";
  attempts: number;
  lastStatus: number | null;
  lastError: string | null;
  createdAt: string;
}

// 2026-11-09 integration API v1b: another system is told the moment something happens (an
// employee, attendance, a leave decision). Signed with a secret shown once; retried with growing
// waits; a failed delivery can be sent again. Owner only - the server checks it.
export default function WebhooksSettingsCard() {
  const { t, i18n } = useTranslation("settings");
  const client = DatabaseManager.getClient();
  const [endpoints, setEndpoints] = useState<Endpoint[] | null>(null);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<string[]>(["attendance.clock_in", "attendance.clock_out"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [deliveriesFor, setDeliveriesFor] = useState<Endpoint | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);

  const load = useCallback(async () => {
    const { data, error: loadError } = await client.rpc("list_prosm_time_webhooks");
    if (loadError) setError(humanizeBackendError(loadError.message, t) ?? loadError.message);
    setEndpoints((data ?? []) as Endpoint[]);
  }, [client, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const call = async (fn: string, args: Record<string, unknown>) => {
    setBusy(true);
    setError("");
    const { data, error: rpcError } = await client.rpc(fn, args);
    setBusy(false);
    if (rpcError) {
      setError(humanizeBackendError(rpcError.message, t) ?? rpcError.message);
      return null;
    }
    return data ?? {};
  };

  const openDeliveries = async (endpoint: Endpoint) => {
    setDeliveriesFor(endpoint);
    const { data } = await client.rpc("list_prosm_time_webhook_deliveries", { p_endpoint_id: endpoint.id });
    setDeliveries((data ?? []) as Delivery[]);
  };

  if (endpoints === null) return null;

  return (
    <Card title={t("integrations.webhooks.title")}>
      <HintText>{t("integrations.webhooks.hint")}</HintText>
      {endpoints.map((endpoint) => (
        <div key={endpoint.id} style={{ borderTop: "1px solid var(--border-light)", padding: "var(--space-2) 0", fontSize: "var(--font-sm)" }}>
          <div dir="ltr" style={{ fontFamily: "monospace", wordBreak: "break-all" }}>{endpoint.url}</div>
          <div style={{ color: "var(--text-secondary)" }}>
            {endpoint.description ? `${endpoint.description} · ` : ""}
            {endpoint.active ? t("integrations.webhooks.active") : t(`integrations.webhooks.off.${endpoint.disabledReason ?? "turned_off"}`)}
            {" · "}
            {t("integrations.webhooks.counts", { delivered: endpoint.delivered7d, dead: endpoint.dead7d, pending: endpoint.pending })}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
            <Button size="xs" variant="ghost" onClick={() => openDeliveries(endpoint)}>{t("integrations.webhooks.deliveries")}</Button>
            <Button size="xs" variant="ghost" loading={busy} onClick={async () => { if (await call("set_prosm_time_webhook_active", { p_id: endpoint.id, p_active: !endpoint.active })) await load(); }}>
              {endpoint.active ? t("integrations.webhooks.turnOff") : t("integrations.webhooks.turnOn")}
            </Button>
            <Button size="xs" variant="danger" loading={busy} onClick={async () => { if (await call("delete_prosm_time_webhook", { p_id: endpoint.id })) await load(); }}>
              {t("integrations.webhooks.delete")}
            </Button>
          </div>
        </div>
      ))}

      <div style={{ display: "grid", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
        <Input label={t("integrations.webhooks.url")} name="webhookUrl" value={url} onChange={(event) => setUrl(event.target.value.trim())} placeholder="https://" />
        <Input label={t("integrations.webhooks.description")} name="webhookDescription" value={description} onChange={(event) => setDescription(event.target.value)} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 6 }}>
          {EVENTS.map((event) => (
            <label key={event} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: "var(--font-sm)" }}>
              <input type="checkbox" checked={events.includes(event)} onChange={() => setEvents((current) => (current.includes(event) ? current.filter((e) => e !== event) : [...current, event]))} />
              {t(eventKey(event))}
            </label>
          ))}
        </div>
        <div>
          <Button loading={busy} disabled={!url.startsWith("https://") || events.length === 0} onClick={async () => {
            const result = await call("create_prosm_time_webhook", { p_url: url, p_events: events, p_description: description || null });
            if (result) {
              setSecret((result as { secret: string }).secret);
              setUrl("");
              setDescription("");
              await load();
            }
          }}>{t("integrations.webhooks.add")}</Button>
        </div>
      </div>
      <ErrorText>{error}</ErrorText>

      <Modal isOpen={secret !== null} onClose={() => setSecret(null)} title={t("integrations.webhooks.secretTitle")}>
        <HintText>{t("integrations.webhooks.secretWarning")}</HintText>
        <input readOnly dir="ltr" value={secret ?? ""} onFocus={(event) => event.target.select()} style={{ width: "100%", fontFamily: "monospace", fontSize: "var(--font-xs)", padding: "var(--space-2)" }} />
      </Modal>

      <Modal isOpen={deliveriesFor !== null} onClose={() => setDeliveriesFor(null)} title={t("integrations.webhooks.deliveries")} size="lg">
        {deliveries.length === 0 ? <HintText>{t("integrations.webhooks.noDeliveries")}</HintText> : deliveries.map((delivery) => (
          <div key={delivery.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", borderTop: "1px solid var(--border-light)", padding: "4px 0", fontSize: "var(--font-sm)" }}>
            <span style={{ flex: 1 }}>
              {t(eventKey(delivery.event))} · {formatDateTime(delivery.createdAt, i18n.language)} · {t(`integrations.webhooks.status.${delivery.status}`)}
              {delivery.attempts ? ` · ${t("integrations.webhooks.attempts", { n: delivery.attempts })}` : ""}
              {delivery.lastError ? <span style={{ color: "var(--text-secondary)" }}> · {delivery.lastError}</span> : null}
            </span>
            {delivery.status === "dead" ? (
              <Button size="xs" loading={busy} onClick={async () => { if (await call("redeliver_prosm_time_webhook", { p_delivery_id: delivery.id }) && deliveriesFor) await openDeliveries(deliveriesFor); }}>
                {t("integrations.webhooks.sendAgain")}
              </Button>
            ) : null}
          </div>
        ))}
      </Modal>
    </Card>
  );
}
