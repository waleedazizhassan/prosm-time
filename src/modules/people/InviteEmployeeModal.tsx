import { useState } from "react";
import { useTranslation } from "react-i18next";

import EmployeeRepository, { type InviteInput, type InviteResultData } from "../../core/repositories/EmployeeRepository";

import Modal from "../../components/common/Modal";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Button from "../../components/common/Button";

const ROLE_OPTIONS: InviteInput["roleKey"][] = ["manager", "supervisor", "employee", "read_only"];

interface InviteEmployeeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onInvited: () => void;
}

// PROSM Time WP-04 - §12's "controlled onboarding." The verification
// code is shown exactly once (§ "controlled one-time display"
// precedent already used for the activation code/API keys elsewhere in
// this codebase) - real email delivery is WP-13's job, not faked here.
export default function InviteEmployeeModal({ isOpen, onClose, onInvited }: InviteEmployeeModalProps) {
  const { t } = useTranslation("people");

  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [roleKey, setRoleKey] = useState<InviteInput["roleKey"]>("employee");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<InviteResultData | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  const reset = () => {
    setEmail("");
    setFullName("");
    setRoleKey("employee");
    setError("");
    setResult(null);
    setLinkCopied(false);
  };

  const handleClose = () => {
    if (submitting) return;
    const hadResult = Boolean(result);
    reset();
    onClose();
    if (hadResult) onInvited();
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setError("");

    const inviteResult = await EmployeeRepository.inviteUser({ email: email.trim(), fullName: fullName.trim(), roleKey });

    setSubmitting(false);

    if (!inviteResult.success) {
      setError(inviteResult.message ?? t("invite.genericError"));
      return;
    }

    setResult(inviteResult.data);
  };

  if (result) {
    const invitationUrl = `${window.location.origin}/accept-invitation?email=${encodeURIComponent(result.email)}&code=${encodeURIComponent(result.verificationCode)}`;

    const handleCopyLink = async () => {
      try {
        await navigator.clipboard.writeText(invitationUrl);
        setLinkCopied(true);
      } catch {
        setLinkCopied(false);
      }
    };

    return (
      <Modal isOpen={isOpen} onClose={handleClose} title={t("invite.successTitle")} footer={<Button onClick={handleClose}>{t("invite.close")}</Button>}>
        <p
          style={{
            color: "var(--status-warning-text)",
            background: "var(--status-warning-bg)",
            border: "1px solid var(--status-warning-border)",
            borderRadius: "var(--radius-sm)",
            padding: "var(--space-2) var(--space-3)",
            fontSize: "var(--font-sm)",
          }}
        >
          {t("invite.oneTimeWarning")}
        </p>

        <Input label={t("invite.linkLabel")} name="invitationLink" value={invitationUrl} onChange={() => {}} readOnly />
        <Button variant="ghost" size="sm" onClick={handleCopyLink}>
          {linkCopied ? t("invite.linkCopied") : t("invite.copyLinkAction")}
        </Button>

        <p style={{ marginTop: "var(--space-4)" }}>
          <strong>{t("invite.codeLabel")}:</strong> <span style={{ fontFamily: "monospace", fontSize: "var(--font-lg)" }}>{result.verificationCode}</span>
        </p>
        <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>{result.email}</p>
      </Modal>
    );
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={t("invite.title")}
      footer={
        <>
          <Button variant="ghost" onClick={handleClose} disabled={submitting}>
            {t("common:actions.cancel")}
          </Button>
          <Button onClick={handleSubmit} loading={submitting}>
            {t("invite.confirm")}
          </Button>
        </>
      }
    >
      <Input label={t("invite.emailLabel")} name="inviteEmail" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={submitting} />
      <Input label={t("invite.fullNameLabel")} name="inviteFullName" value={fullName} onChange={(event) => setFullName(event.target.value)} required disabled={submitting} />
      <Select
        label={t("invite.roleLabel")}
        name="inviteRole"
        value={roleKey}
        onChange={(event) => setRoleKey(event.target.value as InviteInput["roleKey"])}
        disabled={submitting}
        options={ROLE_OPTIONS.map((key) => ({ value: key, label: t(`invite.role.${key}`) }))}
      />
      {error ? <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{error}</p> : null}
    </Modal>
  );
}
