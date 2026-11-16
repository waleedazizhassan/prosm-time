import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { requireSupabaseClient } from "../../core/api/supabaseClient";
import Card from "../../components/common/Card";
import HintText from "../../components/common/HintText";
import { appLocale } from "../../core/utils/formatDate";

interface UsageReport {
  kinds: { kind: "audio" | "video" | "meeting"; sessions: number; bytes: number; relayBytes: number; relayMinutes: number; directMinutes: number; bytesPerMinute: number }[];
  servers: { server: string; bytes: number; minutes: number }[];
  totalRelayBytes: number;
  totalBytes: number;
}

// TURN bandwidth strategy (owner 2026-11-16): this month's calls and meetings - how much went directly between
// devices (free) and how much through a relay (counted against the free relay allowance), per kind and per relay.
// Hidden until the server has the report (migration 20261116130000).
export default function ConnectUsageCard() {
  const { t, i18n } = useTranslation("settings");
  const [report, setReport] = useState<UsageReport | null>(null);

  useEffect(() => {
    void requireSupabaseClient()
      .rpc("get_prosm_time_connect_usage_report")
      .then(({ data, error }) => { if (!error && data) setReport(data as UsageReport); });
  }, []);

  if (!report) return null;
  const locale = appLocale(i18n.language);
  const mb = (bytes: number) => (Number(bytes) / 1048576).toLocaleString(locale, { maximumFractionDigits: 1 });
  const minutes = (value: number) => Number(value).toLocaleString(locale, { maximumFractionDigits: 1 });
  const cell = { padding: "6px 8px", textAlign: "start" as const, borderBottom: "1px solid var(--border-light)" };

  return (
    <Card title={t("connectUsage.title")} subtitle={t("connectUsage.subtitle")}>
      {report.kinds.length === 0 ? <HintText>{t("connectUsage.empty")}</HintText> : (
        <div style={{ overflowX: "auto" }} data-scroll-x>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--font-sm)" }}>
            <thead>
              <tr>
                <th style={cell}>{t("connectUsage.kind")}</th>
                <th style={cell}>{t("connectUsage.sessions")}</th>
                <th style={cell}>{t("connectUsage.directMinutes")}</th>
                <th style={cell}>{t("connectUsage.relayMinutes")}</th>
                <th style={cell}>{t("connectUsage.relayMb")}</th>
                <th style={cell}>{t("connectUsage.perMinute")}</th>
              </tr>
            </thead>
            <tbody>
              {report.kinds.map((row) => (
                <tr key={row.kind}>
                  <td style={cell}>{t(`connectUsage.kinds.${row.kind}`)}</td>
                  <td style={cell}>{row.sessions}</td>
                  <td style={cell}>{minutes(row.directMinutes)}</td>
                  <td style={cell}>{minutes(row.relayMinutes)}</td>
                  <td style={cell}>{mb(row.relayBytes)}</td>
                  <td style={cell}>{mb(row.bytesPerMinute)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <HintText small>{t("connectUsage.total", { relay: mb(report.totalRelayBytes), total: mb(report.totalBytes) })}</HintText>
      {report.servers.map((s) => (
        <HintText small key={s.server}>{t("connectUsage.server", { server: s.server, mb: mb(s.bytes), minutes: minutes(s.minutes) })}</HintText>
      ))}
    </Card>
  );
}
