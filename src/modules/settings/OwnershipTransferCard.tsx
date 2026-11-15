// Governance phase E (owner 2026-11-15): transferring the organisation's ownership - the only way the owner changes.
// The owner starts it, the recipient accepts, 72 hours pass (everyone with management rights is told), then either of
// them completes it; the owner can cancel until then. The server checks every step (and asks to confirm the
// identity when the platform requires it).
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { getSupabaseClient } from "../../core/api/supabaseClient";
import { withStepUp } from "../../core/auth/stepUp";
import { useAuth } from "../../core/context/AuthContext";
import EmployeeRepository, { type OrgMember } from "../../core/repositories/EmployeeRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import Button from "../../components/common/Button";
import Card from "../../components/common/Card";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import SuccessText from "../../components/common/SuccessText";

interface Transfer {
  id: string;
  state: "initiated" | "accepted";
  fromUserId: string;
  toUserId: string;
  toName: string;
  fromName: string;
  reason: string;
  coolingUntil: string | null;
}

const rpc = async (fn: string, args: Record<string, unknown> = {}) => {
  const { data, error } = await getSupabaseClient().rpc(fn, args);
  return { data, error: error ? error.message : null };
};

export default function OwnershipTransferCard({ recipientOnly = false }: { recipientOnly?: boolean }) {
  const { t, i18n } = useTranslation("settings");
  const { profile } = useAuth();
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);
  const isOwner = Boolean(profile?.isRealOwner);

  const load = useCallback(async () => {
    const result = await rpc("get_prosm_time_ownership_transfer");
    setTransfer((result.data as Transfer | null) ?? null);
    setLoaded(true);
    if (isOwner) {
      const list = await EmployeeRepository.listOrganizationMembers();
      setMembers((list.data ?? []).filter((m) => m.isActive && !m.isOwner));
    }
  }, [isOwner]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: string, fn: string, args: Record<string, unknown>, success: string) => {
    setBusy(true);
    setError("");
    setDone("");
    const result = await withStepUp(action, () => rpc(fn, args));
    setBusy(false);
    if (result.error) {
      setError(humanizeBackendError(result.error, t) ?? t("ownership.failed"));
      return;
    }
    setDone(success);
    setReason("");
    await load();
  };

  if (!loaded) return null;
  const mine = transfer && profile?.id === transfer.toUserId;
  if ((!isOwner || recipientOnly) && !mine) return null;
  const ready = transfer?.state === "accepted" && transfer.coolingUntil !== null && new Date(transfer.coolingUntil).getTime() <= Date.now();
  const when = transfer?.coolingUntil ? new Date(transfer.coolingUntil).toLocaleString(i18n.language) : "";

  return (
    <Card title={t("ownership.title")} subtitle={t("ownership.subtitle")}>
      {!transfer ? (
        <>
          <HintText>{t("ownership.explain")}</HintText>
          <Select name="ownership-to" label={t("ownership.to")} value={to} onChange={(e) => setTo(e.target.value)}
            options={[{ value: "", label: t("ownership.choose") }, ...members.map((m) => ({ value: m.id, label: m.fullName }))]} />
          <Input name="ownership-reason" label={t("ownership.reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button variant="danger" disabled={busy || !to || !reason.trim()}
            onClick={() => void act("ownership.transfer", "start_prosm_time_ownership_transfer", { p_to_user_id: to, p_reason: reason.trim() }, t("ownership.started"))}>
            {t("ownership.start")}
          </Button>
        </>
      ) : (
        <>
          <HintText>
            {transfer.state === "initiated"
              ? mine ? t("ownership.waitingForYou", { name: transfer.fromName }) : t("ownership.waitingForThem", { name: transfer.toName })
              : ready ? t("ownership.ready", { name: transfer.toName }) : t("ownership.cooling", { name: transfer.toName, when })}
          </HintText>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
            {mine && transfer.state === "initiated" ? (
              <Button disabled={busy} onClick={() => void act("ownership.accept", "accept_prosm_time_ownership_transfer", { p_transfer_id: transfer.id }, t("ownership.accepted"))}>
                {t("ownership.accept")}
              </Button>
            ) : null}
            {ready ? (
              <Button disabled={busy} onClick={() => void act("ownership.complete", "complete_prosm_time_ownership_transfer", { p_transfer_id: transfer.id }, t("ownership.completed"))}>
                {t("ownership.complete")}
              </Button>
            ) : null}
            <Button variant="ghost" disabled={busy} onClick={() => void act("ownership.cancel", "cancel_prosm_time_ownership_transfer", { p_transfer_id: transfer.id }, t("ownership.cancelled"))}>
              {mine ? t("ownership.decline") : t("ownership.cancel")}
            </Button>
          </div>
        </>
      )}
      {error ? <ErrorText>{error}</ErrorText> : null}
      {done ? <SuccessText>{done}</SuccessText> : null}
    </Card>
  );
}
