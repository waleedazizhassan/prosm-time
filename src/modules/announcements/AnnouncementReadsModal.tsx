import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import AnnouncementRepository, { type AnnouncementRead, type AnnouncementRow } from "../../core/repositories/AnnouncementRepository";
import { formatDateTime } from "../../core/utils/formatDate";
import Modal from "../../components/common/Modal";
import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import LoadingState from "../../components/common/LoadingState";
import { announcementError } from "./announcementsUi";

type Filter = "all" | "notRead" | "notConfirmed";

// 2026-11-09 Media Center: who opened and who confirmed; the server shows each reader the people
// within their authority only.
export default function AnnouncementReadsModal({ row, onClose }: { row: AnnouncementRow; onClose: () => void }) {
  const { t, i18n } = useTranslation("announcements");
  const [reads, setReads] = useState<AnnouncementRead[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    void AnnouncementRepository.reads(row.id).then((result) => {
      if (result.error) setError(announcementError(result.error, t));
      setReads(result.data ?? []);
    });
  }, [row.id, t]);

  const shown = useMemo(() => (reads ?? []).filter((r) => filter === "all" || (filter === "notRead" ? !r.viewedAt : row.requiresAck && !r.acknowledgedAt)), [reads, filter, row.requiresAck]);
  const when = (iso: string | null) => (iso ? formatDateTime(iso, i18n.language) : "-");

  return (
    <Modal isOpen onClose={onClose} title={t("reads.title", { title: row.title })} size="lg">
      <ErrorText>{error}</ErrorText>
      {reads === null ? <LoadingState /> : (
        <>
          <HintText small>
            {t("reads.summary", { total: reads.length, viewed: reads.filter((r) => r.viewedAt).length })}
            {row.requiresAck ? ` · ${t("manage.acknowledged", { count: reads.filter((r) => r.acknowledgedAt).length })}` : ""}
          </HintText>
          <div style={{ display: "flex", gap: "var(--space-1)", flexWrap: "wrap", margin: "var(--space-2) 0" }}>
            {(["all", "notRead", ...(row.requiresAck ? ["notConfirmed"] : [])] as Filter[]).map((key) => (
              <Button key={key} size="xs" variant={filter === key ? "primary" : "ghost"} onClick={() => setFilter(key)}>{t(`reads.filters.${key}`)}</Button>
            ))}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--font-sm)" }}>
              <thead>
                <tr style={{ textAlign: "start" }}>
                  <th style={{ textAlign: "start", padding: 6 }}>{t("reads.name")}</th>
                  <th style={{ textAlign: "start", padding: 6 }}>{t("reads.department")}</th>
                  <th style={{ textAlign: "start", padding: 6 }}>{t("reads.viewed")}</th>
                  {row.requiresAck ? <th style={{ textAlign: "start", padding: 6 }}>{t("reads.confirmed")}</th> : null}
                  {row.sendEmail ? <th style={{ textAlign: "start", padding: 6 }}>{t("reads.email")}</th> : null}
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.userId} style={{ borderTop: "1px solid var(--border-light)" }}>
                    <td style={{ padding: 6 }}>{r.name}</td>
                    <td style={{ padding: 6 }}>{r.department ?? "-"}</td>
                    <td style={{ padding: 6 }}>{when(r.viewedAt)}</td>
                    {row.requiresAck ? <td style={{ padding: 6 }}>{when(r.acknowledgedAt)}</td> : null}
                    {row.sendEmail ? <td style={{ padding: 6 }}>{t(`reads.emailStatus.${r.emailStatus}`)}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shown.length === 0 ? <HintText small>{t("reads.nobody")}</HintText> : null}
        </>
      )}
    </Modal>
  );
}
