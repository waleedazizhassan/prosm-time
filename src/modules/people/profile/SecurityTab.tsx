// Governance phase C (owner 2026-11-15): two-step sign-in (an authenticator app, TOTP) for one's own account.
// Supabase Auth keeps the secret; the app only shows the QR code once, verifies the first code, and lists or
// removes the authenticator. Works the same on the web and inside the Android app (no native library).
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { getSupabaseClient } from "../../../core/api/supabaseClient";
import Button from "../../../components/common/Button";
import Card from "../../../components/common/Card";
import ErrorText from "../../../components/common/ErrorText";
import HintText from "../../../components/common/HintText";
import Input from "../../../components/common/Input";
import SuccessText from "../../../components/common/SuccessText";
import OwnershipTransferCard from "../../settings/OwnershipTransferCard";

interface Enrolment {
  factorId: string;
  qr: string;
  secret: string;
}

export default function SecurityTab() {
  const { t } = useTranslation("people");
  const [factors, setFactors] = useState<{ id: string; friendlyName?: string; createdAt: string }[]>([]);
  const [required, setRequired] = useState(false);
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const client = getSupabaseClient();
    const { data } = await client.auth.mfa.listFactors();
    setFactors((data?.totp ?? []).filter((f) => f.status === "verified").map((f) => ({ id: f.id, friendlyName: f.friendly_name, createdAt: f.created_at })));
    const policy = await client.rpc("get_prosm_time_step_up_policy");
    setRequired(Boolean((policy.data as { mfaRequired?: boolean } | null)?.mfaRequired));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const start = async () => {
    setBusy(true);
    setError("");
    setDone("");
    const { data, error: enrolError } = await getSupabaseClient().auth.mfa.enroll({ factorType: "totp", friendlyName: `PROSM ${new Date().toISOString().slice(0, 10)}` });
    setBusy(false);
    if (enrolError || !data) {
      setError(t("security.failed"));
      return;
    }
    setEnrolment({ factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  };

  const verify = async () => {
    if (!enrolment) return;
    setBusy(true);
    setError("");
    const { error: verifyError } = await getSupabaseClient().auth.mfa.challengeAndVerify({ factorId: enrolment.factorId, code: code.trim() });
    setBusy(false);
    if (verifyError) {
      setError(t("security.wrongCode"));
      return;
    }
    setEnrolment(null);
    setCode("");
    setDone(t("security.enabled"));
    await load();
  };

  const cancel = async () => {
    if (enrolment) await getSupabaseClient().auth.mfa.unenroll({ factorId: enrolment.factorId }).catch(() => undefined);
    setEnrolment(null);
    setCode("");
  };

  const remove = async (factorId: string) => {
    setBusy(true);
    setError("");
    setDone("");
    // Supabase asks for a verified second factor in this session (aal2) before removing one
    const { error: removeError } = await getSupabaseClient().auth.mfa.unenroll({ factorId });
    setBusy(false);
    if (removeError) {
      setError(t("security.removeNeedsCode"));
      return;
    }
    setDone(t("security.removed"));
    await load();
  };

  return (
    <>
    {/* governance phase E: an ownership transfer waiting for this person */}
    <OwnershipTransferCard recipientOnly />
    <Card title={t("security.title")} subtitle={t("security.subtitle")}>
      {required && factors.length === 0 ? <HintText>{t("security.requiredForYou")}</HintText> : null}
      {factors.length > 0 ? (
        <>
          <HintText>{t("security.on")}</HintText>
          {factors.map((factor) => (
            <div key={factor.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-2)", marginBlock: "var(--space-2)" }}>
              <span>{factor.friendlyName ?? t("security.authenticator")}</span>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove(factor.id)}>{t("security.remove")}</Button>
            </div>
          ))}
        </>
      ) : null}
      {factors.length === 0 && !enrolment ? (
        <>
          <HintText>{t("security.off")}</HintText>
          <Button disabled={busy} onClick={() => void start()}>{t("security.enable")}</Button>
        </>
      ) : null}
      {enrolment ? (
        <>
          <HintText>{t("security.scan")}</HintText>
          <img src={enrolment.qr} alt={t("security.qrAlt")} style={{ width: 200, height: 200, background: "#fff", padding: 8, borderRadius: 8 }} />
          <HintText small>{t("security.secret", { secret: enrolment.secret })}</HintText>
          <Input name="totp-code" label={t("security.code")} value={code} inputMode="numeric" autoComplete="one-time-code"
            onChange={(event) => setCode(event.target.value)} />
          <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
            <Button disabled={busy || code.trim().length < 6} onClick={() => void verify()}>{t("security.verify")}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => void cancel()}>{t("security.cancel")}</Button>
          </div>
        </>
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
      {done ? <SuccessText>{done}</SuccessText> : null}
    </Card>
    </>
  );
}
