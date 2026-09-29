import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import LicenseRepository, { type TrialStatus } from "../../core/repositories/LicenseRepository";
import { useAuth } from "../../core/context/AuthContext";
import { formatDateOnly } from "../../core/utils/formatDate";

import AuthLayout from "../../components/common/AuthLayout";
import Input from "../../components/common/Input";
import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";
import styles from "../../components/common/AuthLayout.module.css";

// Demo (owner 2026-09-29): the trial has ended. The organisation is paused, never deleted:
// the owner enters a purchased activation code, or the license is renewed in PROSM Platform
// Manager ("Check again" picks that up) - either way it continues with all its data.
export default function TrialEndedPage({ status, onReopened }: { status: TrialStatus; onReopened: () => void }) {
  const { t, i18n } = useTranslation(["auth", "common"]);
  const { signOut } = useAuth();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"" | "code" | "check">("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const activate = async (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim()) return;
    setBusy("code");
    setError("");
    const result = await LicenseRepository.activateWithCode(code.trim());
    setBusy("");
    if (!result.success) {
      setError(result.message ?? t("auth:trial.activateError"));
      return;
    }
    onReopened();
  };

  const checkAgain = async () => {
    setBusy("check");
    setError("");
    setNote("");
    await LicenseRepository.refreshCurrentLicenseStatus();
    const after = await LicenseRepository.getTrialStatus();
    setBusy("");
    if (after.success && after.data && !after.data.locked) onReopened();
    else setNote(t("auth:trial.stillEnded"));
  };

  return (
    <AuthLayout title={t("auth:trial.endedTitle")} subtitle={t("auth:trial.endedSubtitle", { organization: status.organizationName ?? "", date: status.expiresAt ? formatDateOnly(status.expiresAt, i18n.language) : "" })}>
      <p className={styles.consentNotice}>{t("auth:trial.dataKept")}</p>
      {status.isOwner ? (
        <form onSubmit={activate}>
          <Input label={t("auth:activation.activationCodeLabel")} name="trialActivationCode" value={code} onChange={(event) => setCode(event.target.value)} required disabled={!!busy} />
          <ErrorText>{error}</ErrorText>
          <Button type="submit" fullWidth loading={busy === "code"} disabled={!code.trim() || !!busy}>
            {t("auth:trial.activateAction")}
          </Button>
        </form>
      ) : (
        <p className={styles.consentNotice}>{t("auth:trial.askOwner")}</p>
      )}
      <p className={styles.consentNotice}>
        {t("auth:trial.contactIntro", { license: status.licenseNumber ?? "" })}
        <br />
        <a href="mailto:sales@prosm.net">sales@prosm.net</a> · <a href="mailto:info@prosm.net">info@prosm.net</a> · <a href="mailto:support@prosm.net">support@prosm.net</a>
      </p>
      {note ? <p className={styles.consentNotice}>{note}</p> : null}
      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
        <Button variant="ghost" loading={busy === "check"} disabled={!!busy} onClick={checkAgain}>
          {t("auth:trial.checkAgain")}
        </Button>
        <Button variant="ghost" onClick={() => void signOut()}>
          {t("auth:trial.signOut")}
        </Button>
      </div>
    </AuthLayout>
  );
}
