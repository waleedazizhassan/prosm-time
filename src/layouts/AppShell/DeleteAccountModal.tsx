import { useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";
import Input from "../../components/common/Input";
import Modal from "../../components/common/Modal";
import AuthService from "../../core/auth/AuthService";
import { requireSupabaseClient } from "../../core/api/supabaseClient";
import { useAuth } from "../../core/context/AuthContext";

// v2.3.55 (owner 2026-10-27, for Google Play: "the user can delete their
// account from the user menu"). What goes and what stays is said first; the
// password is asked again, so a phone left unlocked cannot do it. The Owner's
// account holds the organisation: the Owner writes to support instead.
export default function DeleteAccountModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { t } = useTranslation("shell");
  const { profile, signOut } = useAuth();
  const [password, setPassword] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isOwner = Boolean(profile?.isOwner);
  const word = t("deleteAccount.confirmWord");

  const close = () => {
    setPassword("");
    setConfirmText("");
    setError("");
    onClose();
  };

  const remove = async () => {
    if (!profile?.email) return;
    setBusy(true);
    setError("");
    // the password, again
    const check = await AuthService.signIn(profile.email, password);
    if (!check.success) {
      setBusy(false);
      setError(t("deleteAccount.wrongPassword"));
      return;
    }
    try {
      const { error: invokeError } = await requireSupabaseClient().functions.invoke("delete-my-account", { body: {} });
      if (invokeError) {
        const detail = await (invokeError as { context?: Response }).context?.json?.().catch(() => null);
        const code = detail?.error?.code ?? "";
        setError(code === "CLOCKED_IN" ? t("deleteAccount.clockedIn") : t("deleteAccount.failed"));
        setBusy(false);
        return;
      }
    } catch {
      setError(t("deleteAccount.failed"));
      setBusy(false);
      return;
    }
    await signOut().catch(() => undefined);
    window.location.assign("/login?accountDeleted=1");
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      title={t("deleteAccount.title")}
      footer={
        isOwner ? (
          <Button variant="ghost" onClick={() => window.open(`mailto:support@prosm.net?subject=${encodeURIComponent(t("deleteAccount.ownerSubject"))}`)}>
            {t("deleteAccount.ownerAction")}
          </Button>
        ) : (
          <Button variant="danger" onClick={remove} loading={busy} disabled={!password || confirmText.trim() !== word}>
            {t("deleteAccount.action")}
          </Button>
        )
      }
    >
      {isOwner ? (
        <p style={{ margin: 0, fontSize: "var(--font-sm)", lineHeight: 1.6 }}>{t("deleteAccount.ownerBody")}</p>
      ) : (
        <>
          <p style={{ margin: "0 0 var(--space-2)", fontSize: "var(--font-sm)", lineHeight: 1.6 }}>{t("deleteAccount.whatGoes")}</p>
          <p style={{ margin: "0 0 var(--space-3)", fontSize: "var(--font-sm)", lineHeight: 1.6, color: "var(--text-secondary)" }}>{t("deleteAccount.whatStays")}</p>
          <Input label={t("deleteAccount.passwordLabel")} name="deleteAccountPassword" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
          <Input label={t("deleteAccount.confirmLabel", { word })} name="deleteAccountConfirm" value={confirmText} onChange={(event) => setConfirmText(event.target.value)} />
          <ErrorText>{error}</ErrorText>
        </>
      )}
    </Modal>
  );
}
