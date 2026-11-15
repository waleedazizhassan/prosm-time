// Governance phase C (owner 2026-11-15): the "confirm it's you" window. Signing in again with the password gives a
// fresh sign-in time in the token (amr); when the server asks for MFA, the authenticator code is verified as well
// (aal2). The server checks the token - this window only helps the person produce a fresh one.
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { getSupabaseClient } from "../../core/api/supabaseClient";
import { registerStepUpConfirmer, type StepUpCode } from "../../core/auth/stepUp";
import Button from "./Button";
import ErrorText from "./ErrorText";
import HintText from "./HintText";
import Input from "./Input";
import Modal from "./Modal";

export default function StepUpHost() {
  const { t } = useTranslation("common");
  const [code, setCode] = useState<StepUpCode | null>(null);
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [needsOtp, setNeedsOtp] = useState(false);
  const [noFactor, setNoFactor] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const finish = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setCode(null);
    setPassword("");
    setOtp("");
    setError("");
    setBusy(false);
  }, []);

  useEffect(() => {
    registerStepUpConfirmer(async (next) => {
      let factorMissing = false;
      if (next === "MFA_REQUIRED") {
        const { data } = await getSupabaseClient().auth.mfa.listFactors();
        factorMissing = !(data?.totp ?? []).some((factor) => factor.status === "verified");
      }
      setNoFactor(factorMissing);
      setNeedsOtp(next === "MFA_REQUIRED" && !factorMissing);
      setCode(next);
      return new Promise<boolean>((resolve) => {
        resolver.current = resolve;
      });
    });
    return () => registerStepUpConfirmer(null);
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const client = getSupabaseClient();
    const { data: userData } = await client.auth.getUser();
    const email = userData.user?.email;
    if (!email) {
      setError(t("stepUp.failed"));
      setBusy(false);
      return;
    }
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error) {
      setError(t("stepUp.wrongPassword"));
      setBusy(false);
      return;
    }
    if (needsOtp) {
      const { data: factors } = await client.auth.mfa.listFactors();
      const factor = (factors?.totp ?? []).find((item) => item.status === "verified");
      const verified = factor ? await client.auth.mfa.challengeAndVerify({ factorId: factor.id, code: otp.trim() }) : null;
      if (!verified || verified.error) {
        setError(t("stepUp.wrongCode"));
        setBusy(false);
        return;
      }
    }
    finish(true);
  };

  return (
    <Modal isOpen={code !== null} onClose={() => finish(false)} title={t("stepUp.title")}>
      {noFactor ? (
        <>
          <HintText>{t("stepUp.enableMfaFirst")}</HintText>
          <Button variant="ghost" onClick={() => finish(false)}>{t("stepUp.close")}</Button>
        </>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <HintText>{needsOtp ? t("stepUp.explainMfa") : t("stepUp.explain")}</HintText>
          <Input name="step-up-password" type="password" label={t("stepUp.password")} value={password}
            onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
          {needsOtp ? (
            <Input name="step-up-code" label={t("stepUp.code")} value={otp} inputMode="numeric" autoComplete="one-time-code"
              onChange={(event) => setOtp(event.target.value)} required />
          ) : null}
          {error ? <ErrorText>{error}</ErrorText> : null}
          <Button type="submit" disabled={busy || !password || (needsOtp && otp.trim().length < 6)} fullWidth>
            {t("stepUp.confirm")}
          </Button>
        </form>
      )}
    </Modal>
  );
}
