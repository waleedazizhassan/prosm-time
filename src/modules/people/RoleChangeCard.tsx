import { useState } from "react";
import { useTranslation } from "react-i18next";

import DatabaseManager from "../../core/database/DatabaseManager";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import Card from "../../components/common/Card";
import Select from "../../components/common/Select";
import Textarea from "../../components/common/Textarea";
import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";

const ROLES = ["manager", "supervisor", "employee", "read_only"] as const;

// 2026-11-09 spec B-01: change a person's role. The server decides who may (the owner, or whoever
// holds permissions.assign, for a role below their own), applies it to the permissions at once,
// takes site management away below manager, and returns the direct grants left for review.
export default function RoleChangeCard({ userId, currentRole, onChanged }: { userId: string; currentRole: string; onChanged: () => void }) {
  const { t } = useTranslation("people");
  const [role, setRole] = useState(currentRole);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ managedSitesRemoved: number; directGrants: { permission: string; granted: boolean }[] } | null>(null);

  const save = async () => {
    setBusy(true);
    setError("");
    setResult(null);
    const { data, error: rpcError } = await DatabaseManager.getClient().rpc("change_prosm_time_user_role", { p_user_id: userId, p_role_key: role, p_reason: reason.trim() });
    setBusy(false);
    if (rpcError) {
      setError(humanizeBackendError(rpcError.message, t) ?? rpcError.message);
      return;
    }
    setResult(data);
    setReason("");
    onChanged();
  };

  return (
    <Card title={t("roleChange.title")}>
      <HintText small>{t("roleChange.hint")}</HintText>
      <div style={{ display: "grid", gap: "var(--space-2)", maxWidth: 420 }}>
        <Select label={t("roleChange.role")} name="roleChangeRole" value={role} onChange={(event) => setRole(event.target.value)}
          options={ROLES.map((key) => ({ value: key, label: t(`common:roles.${key}`) }))} />
        <Textarea label={t("roleChange.reason")} name="roleChangeReason" value={reason} onChange={(event) => setReason(event.target.value)} />
        <div>
          <Button loading={busy} disabled={role === currentRole || reason.trim().length < 3} onClick={save}>{t("roleChange.save")}</Button>
        </div>
      </div>
      <ErrorText>{error}</ErrorText>
      {result ? (
        <div role="status" style={{ marginTop: "var(--space-2)", fontSize: "var(--font-sm)" }}>
          <div>{t("roleChange.done")}</div>
          {result.managedSitesRemoved > 0 ? <div>{t("roleChange.sitesRemoved", { n: result.managedSitesRemoved })}</div> : null}
          {result.directGrants.length > 0 ? (
            <div>
              {t("roleChange.grantsLeft")}{" "}
              {result.directGrants.map((g) => `${t(`catalog.${g.permission}`, { defaultValue: g.permission })} (${g.granted ? t("roleChange.granted") : t("roleChange.revoked")})`).join(", ")}
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
