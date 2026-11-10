import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "../../core/context/AuthContext";
import AnnouncementRepository, { type AnnouncementRow, type MyAnnouncement } from "../../core/repositories/AnnouncementRepository";
import { formatDateTime } from "../../core/utils/formatDate";
import PageShell from "../../components/common/PageShell";
import PageBanner from "../../components/common/PageBanner";
import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import Modal from "../../components/common/Modal";
import Textarea from "../../components/common/Textarea";
import StatusBadge from "../../components/common/StatusBadge";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import EmptyState from "../../components/common/EmptyState";
import LoadingState from "../../components/common/LoadingState";
import illustration from "../../assets/illustrations/employeeHome.svg";
import AnnouncementEditor from "./AnnouncementEditor";
import AnnouncementReadsModal from "./AnnouncementReadsModal";
import { announcementError } from "./announcementsUi";
import { AttachmentList, useOpenAttachment } from "./AttachmentList";
import SuccessText from "../../components/common/SuccessText";

const STATUS_BADGE: Record<string, string> = { draft: "inactive", scheduled: "pending", published: "active", expired: "inactive", withdrawn: "inactive" };

// 2026-11-09 Media Center: everyone sees what was addressed to them; whoever may publish also
// writes, schedules, publishes and withdraws, and sees who read.
export default function AnnouncementsPage() {
  const { t, i18n } = useTranslation("announcements");
  const { hasPermission } = useAuth();
  const canPublish = hasPermission("announcements.publish") || hasPermission("announcements.manage");
  const canSeeReads = hasPermission("announcements.view_reads");
  const [tab, setTab] = useState<"mine" | "manage">("mine");
  const [mine, setMine] = useState<{ unread: number; items: MyAnnouncement[] } | null>(null);
  const [managed, setManaged] = useState<AnnouncementRow[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reading, setReading] = useState<MyAnnouncement | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [readsOf, setReadsOf] = useState<AnnouncementRow | null>(null);
  const [withdrawing, setWithdrawing] = useState<AnnouncementRow | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState("");
  const openAttachment = useOpenAttachment(setError);

  const loadMine = useCallback(async () => {
    const result = await AnnouncementRepository.mine();
    if (result.error) setError(announcementError(result.error, t));
    setMine(result.data ?? { unread: 0, items: [] });
  }, [t]);

  const loadManaged = useCallback(async () => {
    if (!canPublish) return;
    const result = await AnnouncementRepository.listManaged();
    if (result.error) setError(announcementError(result.error, t));
    setManaged(result.data ?? []);
  }, [canPublish, t]);

  useEffect(() => {
    void loadMine();
    void loadManaged();
  }, [loadMine, loadManaged]);

  const open = async (item: MyAnnouncement) => {
    setReading(item);
    if (!item.viewedAt) {
      await AnnouncementRepository.markRead(item.id, false);
      void loadMine();
    }
  };

  const acknowledge = async () => {
    if (!reading) return;
    setBusy("ack");
    const result = await AnnouncementRepository.markRead(reading.id, true);
    setBusy("");
    if (result.error) setError(announcementError(result.error, t));
    else setReading({ ...reading, acknowledgedAt: new Date().toISOString() });
    void loadMine();
  };

  const withdraw = async () => {
    if (!withdrawing) return;
    setBusy("withdraw");
    const result = await AnnouncementRepository.withdraw(withdrawing.id, reason.trim());
    setBusy("");
    if (result.error) {
      setError(announcementError(result.error, t));
      return;
    }
    setWithdrawing(null);
    setReason("");
    setNotice(result.data?.status === "draft" ? t("manage.backToDraft") : t("manage.withdrawn"));
    void loadManaged();
    void loadMine();
  };

  const when = (iso: string | null) => (iso ? formatDateTime(iso, i18n.language) : "");

  return (
    <PageShell title="">
      <PageBanner pageId="announcements" illustration={illustration} />
      {canPublish ? (
        <div role="tablist" style={{ display: "flex", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
          <Button size="sm" variant={tab === "mine" ? "primary" : "ghost"} onClick={() => setTab("mine")}>
            {t("tabs.mine")}{mine && mine.unread > 0 ? ` (${mine.unread})` : ""}
          </Button>
          <Button size="sm" variant={tab === "manage" ? "primary" : "ghost"} onClick={() => setTab("manage")}>{t("tabs.manage")}</Button>
        </div>
      ) : null}
      <ErrorText>{error}</ErrorText>
      {notice ? <SuccessText>{notice}</SuccessText> : null}

      {tab === "mine" ? (
        <>
          {mine === null ? <LoadingState /> : mine.items.length === 0 ? <EmptyState message={t("mine.empty")} /> : null}
          {mine?.items.map((item) => {
            const pending = !item.viewedAt || (item.requiresAck && !item.acknowledgedAt);
            return (
              <Card key={item.id} title={item.title} subtitle={`${item.kind === "statement" ? t("kinds.statement") : t("kinds.announcement")} · ${when(item.publishedAt)}${item.author ? ` · ${item.author}` : ""}`}>
                <HintText small>
                  {pending ? <StatusBadge status="pending">{item.viewedAt ? t("mine.confirmNeeded") : t("mine.new")}</StatusBadge> : <StatusBadge status="active">{item.acknowledgedAt ? t("mine.confirmed") : t("mine.read")}</StatusBadge>}
                  {item.attachments.length > 0 ? ` · ${t("mine.attachments", { count: item.attachments.length })}` : ""}
                </HintText>
                <Button size="sm" onClick={() => void open(item)}>{t("mine.open")}</Button>
              </Card>
            );
          })}
        </>
      ) : (
        <>
          <div style={{ marginBottom: "var(--space-3)" }}>
            <Button onClick={() => setEditing("new")}>{t("manage.new")}</Button>
          </div>
          {managed === null ? <LoadingState /> : managed.length === 0 ? <EmptyState message={t("manage.empty")} /> : null}
          {managed?.map((row) => (
            <Card key={row.id} title={row.title}
              subtitle={`${t(`kinds.${row.kind}`)} · ${t(`audience.${row.audienceType}`)}${row.audienceType !== "all" ? ` (${row.audienceCount})` : ""}${row.author ? ` · ${row.author}` : ""}`}>
              <HintText small>
                <StatusBadge status={STATUS_BADGE[row.status] ?? "inactive"}>{t(`statuses.${row.status}`)}</StatusBadge>
                {row.status === "scheduled" && row.publishAt ? ` ${t("manage.scheduledFor", { time: when(row.publishAt) })}` : ""}
                {row.publishedAt ? ` ${t("manage.publishedOn", { time: when(row.publishedAt) })}` : ""}
                {row.expiresAt ? ` · ${t("manage.expiresOn", { time: when(row.expiresAt) })}` : ""}
              </HintText>
              {row.recipients > 0 ? (
                <HintText small>
                  {t("manage.counts", { recipients: row.recipients, viewed: row.viewed })}
                  {row.requiresAck ? ` · ${t("manage.acknowledged", { count: row.acknowledged })}` : ""}
                  {row.sendEmail ? ` · ${t("manage.withEmail")}` : ""}
                </HintText>
              ) : null}
              <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
                {row.status === "draft" || row.status === "scheduled" ? <Button size="sm" onClick={() => setEditing(row.id)}>{t("manage.edit")}</Button> : null}
                {canSeeReads && row.recipients > 0 ? <Button size="sm" variant="ghost" onClick={() => setReadsOf(row)}>{t("manage.whoRead")}</Button> : null}
                {row.status === "scheduled" || row.status === "published" || row.status === "expired" ? (
                  <Button size="sm" variant="danger" onClick={() => { setWithdrawing(row); setReason(""); }}>{row.status === "scheduled" ? t("manage.unschedule") : t("manage.withdraw")}</Button>
                ) : null}
              </div>
            </Card>
          ))}
        </>
      )}

      <Modal isOpen={Boolean(reading)} onClose={() => setReading(null)} title={reading?.title ?? ""} size="lg"
        footer={reading?.requiresAck ? (
          reading.acknowledgedAt ? <HintText small>{t("mine.confirmedOn", { time: when(reading.acknowledgedAt) })}</HintText>
            : <Button loading={busy === "ack"} onClick={acknowledge}>{t("mine.confirm")}</Button>
        ) : null}>
        {reading ? (
          <div>
            <HintText small>{`${t(`kinds.${reading.kind}`)} · ${when(reading.publishedAt)}${reading.author ? ` · ${reading.author}` : ""}`}</HintText>
            <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.8, overflowWrap: "anywhere" }}>{reading.body}</div>
            <AttachmentList items={reading.attachments} onOpen={(item) => void openAttachment(item)} />
          </div>
        ) : null}
      </Modal>

      <Modal isOpen={Boolean(withdrawing)} onClose={() => setWithdrawing(null)} title={withdrawing?.status === "scheduled" ? t("manage.unschedule") : t("manage.withdraw")}
        footer={<Button variant="danger" loading={busy === "withdraw"} disabled={withdrawing?.status !== "scheduled" && reason.trim().length < 3} onClick={withdraw}>{t("manage.confirm")}</Button>}>
        <HintText>{withdrawing?.status === "scheduled" ? t("manage.unscheduleHint") : t("manage.withdrawHint")}</HintText>
        {withdrawing?.status !== "scheduled" ? <Textarea label={t("manage.reason")} name="withdrawReason" value={reason} onChange={(event) => setReason(event.target.value)} /> : null}
      </Modal>

      {editing ? (
        <AnnouncementEditor id={editing === "new" ? null : editing} onClose={() => setEditing(null)}
          onDone={(message) => { setEditing(null); setNotice(message); void loadManaged(); void loadMine(); }} />
      ) : null}
      {readsOf ? <AnnouncementReadsModal row={readsOf} onClose={() => setReadsOf(null)} /> : null}
    </PageShell>
  );
}
