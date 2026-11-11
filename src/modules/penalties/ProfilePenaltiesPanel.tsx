import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Award, Gavel } from "lucide-react";

import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import StatusBadge from "../../components/common/StatusBadge";
import EmptyState from "../../components/common/EmptyState";
import LoadingState from "../../components/common/LoadingState";
import SuccessText from "../../components/common/SuccessText";
import { formatDateOnly } from "../../core/utils/formatDate";
import { useAuth } from "../../core/context/AuthContext";
import type { EmployeeProfile } from "../../core/repositories/EmployeeProfileRepository";
import PenaltiesRepository, { type Incentive, type Violation } from "../../core/repositories/PenaltiesRepository";
import ViolationDetailModal from "./ViolationDetailModal";
import { GrantIncentiveModal, RecordViolationModal } from "./RecordModals";
import { actionText, incentiveValueText, money, STATUS_BADGE, violationName } from "./penaltyUi";

// HR suite feature 1: the person's record in their file - warnings, deductions and incentives, newest
// first. The person sees what they were told and acknowledges or appeals here; a manager records or
// proposes from here too.
export default function ProfilePenaltiesPanel({ profile: file }: { profile: EmployeeProfile }) {
  const { t, i18n } = useTranslation("penalties");
  const { profile } = useAuth();
  const userId = file.header.id;
  const self = profile?.id === userId;
  const [rows, setRows] = useState<Violation[] | null>(null);
  const [incentives, setIncentives] = useState<Incentive[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [record, setRecord] = useState(false);
  const [grant, setGrant] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    const [v, i] = await Promise.all([PenaltiesRepository.list(userId), PenaltiesRepository.incentives(userId)]);
    setRows(v.data ?? []);
    setIncentives(i.data ?? []);
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!rows) return <LoadingState />;
  const needsMe = rows.filter((r) => r.actions.some((a) => a === "respond" || a === "acknowledge"));

  return (
    <>
      <Card title={t("profileTitle")}
        actions={!self ? (
          <span style={{ display: "inline-flex", gap: 6 }}>
            <Button size="sm" variant="ghost" onClick={() => setRecord(true)}>{t("record.button")}</Button>
            <Button size="sm" variant="ghost" onClick={() => setGrant(true)}>{t("incentive.button")}</Button>
          </span>
        ) : undefined}>
        {notice ? <SuccessText>{notice}</SuccessText> : null}
        {self && needsMe.length > 0 ? <p style={{ margin: "0 0 var(--space-2)", fontWeight: 600 }}>{t("needsYou", { count: needsMe.length })}</p> : null}
        {rows.length === 0 && incentives.length === 0 ? <EmptyState message={self ? t("emptySelf") : t("empty")} /> : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {incentives.filter((i) => i.status === "approved" || !self).map((i) => (
              <li key={`i${i.id}`} style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap", padding: "var(--space-2) 0", borderBottom: "1px solid var(--border-light)" }}>
                <Award size={18} aria-hidden="true" color="var(--status-success-text, #15803d)" />
                <div style={{ flex: "1 1 12rem", minWidth: 0 }}>
                  <strong>{i.templateKey && !i.ruleName ? t(`incentiveTemplates.${i.templateKey}`) : i.reason}</strong>
                  <div style={{ color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>
                    {formatDateOnly(i.createdAt, i18n.language)} · {incentiveValueText(t, i.amountType, i.value, i18n.language)}{i.amount != null ? ` · ${money(i.amount, i18n.language)}` : ""}
                  </div>
                </div>
                <StatusBadge status={i.status === "approved" ? "active" : i.status === "pending_approval" ? "pending" : "deactivated"}>{t(`incentiveStatus.${i.status}`)}</StatusBadge>
              </li>
            ))}
            {rows.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => setOpenId(r.id)}
                  style={{ display: "flex", width: "100%", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap", padding: "var(--space-2) 0", border: 0, borderBottom: "1px solid var(--border-light)", background: "none", color: "inherit", font: "inherit", textAlign: "start", cursor: "pointer" }}>
                  <Gavel size={18} aria-hidden="true" />
                  <span style={{ flex: "1 1 12rem", minWidth: 0 }}>
                    <strong>{violationName(t, r)}</strong>
                    <span style={{ display: "block", color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>
                      {formatDateOnly(r.occurredOn, i18n.language)} · {t("occurrence", { count: r.occurrence })} · {actionText(t, r.finalAction, i18n.language)}
                    </span>
                  </span>
                  <StatusBadge status={STATUS_BADGE[r.status]}>{t(`status.${r.status}`)}</StatusBadge>
                  {r.actions.includes("acknowledge") || r.actions.includes("respond") ? <StatusBadge status="invited">{t("yourTurn")}</StatusBadge> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <ViolationDetailModal id={openId} onClose={() => setOpenId(null)} onChanged={() => void load()} />
      <RecordViolationModal open={record} userId={userId} onClose={() => setRecord(false)} onDone={() => { setRecord(false); setNotice(t("record.done")); void load(); }} />
      <GrantIncentiveModal open={grant} userId={userId} onClose={() => setGrant(false)} onDone={() => { setGrant(false); setNotice(t("incentive.done.proposed")); void load(); }} />
    </>
  );
}
