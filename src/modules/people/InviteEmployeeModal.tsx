import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "../../core/context/AuthContext";
import usePlanFeatures from "../../core/hooks/usePlanFeatures";
import EmployeeRepository, { type InviteInput, type InviteResultData } from "../../core/repositories/EmployeeRepository";
import AnnouncementRepository, { type Department } from "../../core/repositories/AnnouncementRepository";
import { roleRank } from "../../core/utils/roleRank";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import Modal from "../../components/common/Modal";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";

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
  const { t } = useTranslation(["people", "announcements"]);
  const { profile } = useAuth();
  const { allows } = usePlanFeatures(profile?.id);
  // Security review 2026-10-20: only roles below the inviter's own (the Owner: any) - the server refuses the rest.
  const roleOptions = ROLE_OPTIONS.filter((key) => (key !== "manager" && key !== "supervisor") || allows("roles_manager"))
    .filter((key) => key !== "read_only" || allows("roles_all"))
    .filter(
    (key) => !profile || profile.isOwner || roleRank({ isOwner: false, roleKey: key }) < roleRank({ isOwner: false, roleKey: profile.roleKey }),
  );

  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  // owner 2026-11-12: the full legal name (for payslips, reports and official papers); the short name is the account's
  const [legalName, setLegalName] = useState("");
  const [roleKey, setRoleKey] = useState<InviteInput["roleKey"]>("employee");
  // 2026-11-09 Media Center: the department is chosen when the person is added
  const [departmentId, setDepartmentId] = useState("");
  const [departments, setDepartments] = useState<Department[]>([]);
  useEffect(() => {
    void AnnouncementRepository.departments().then((r) => setDepartments((r.data ?? []).filter((d) => d.isActive)));
  }, []);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<InviteResultData | null>(null);

  const reset = () => {
    setEmail("");
    setFullName("");
    setLegalName("");
    setRoleKey("employee");
    setError("");
    setResult(null);
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

    const inviteResult = await EmployeeRepository.inviteUser({ email: email.trim(), fullName: fullName.trim(), roleKey, departmentId: departmentId || null });

    setSubmitting(false);

    if (!inviteResult.success) {
      setError(humanizeBackendError(inviteResult.message, t) ?? t("invite.genericError"));
      return;
    }

    if (inviteResult.data?.userId && legalName.trim()) {
      const legal = await EmployeeRepository.setLegalName(inviteResult.data.userId, legalName.trim());
      if (!legal.success) setError(humanizeBackendError(legal.message, t) ?? t("invite.legalNameNotSaved"));
    }
    setResult(inviteResult.data);
  };

  if (result) {
    return (
      <Modal isOpen={isOpen} onClose={handleClose} title={t("invite.successTitle")} footer={<Button onClick={handleClose}>{t("invite.close")}</Button>}>
        <p
          style={
            result.emailSent
              ? { color: "var(--status-success-text)", background: "var(--status-success-bg)", border: "1px solid var(--status-success-border)", borderRadius: "var(--radius-sm)", padding: "var(--space-2) var(--space-3)", fontSize: "var(--font-sm)" }
              : { color: "var(--status-warning-text)", background: "var(--status-warning-bg)", border: "1px solid var(--status-warning-border)", borderRadius: "var(--radius-sm)", padding: "var(--space-2) var(--space-3)", fontSize: "var(--font-sm)" }
          }
        >
          {result.emailSent ? t("invite.emailSentNotice", { email: result.email }) : t("invite.emailNotSentNotice")}
        </p>

        <p style={{ marginTop: "var(--space-4)" }}>
          <strong>{t("invite.codeLabel")}:</strong> <span style={{ fontFamily: "monospace", fontSize: "var(--font-lg)" }}>{result.verificationCode}</span>
        </p>
        <HintText>{result.email}</HintText>
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
          <Button onClick={handleSubmit} loading={submitting} disabled={!legalName.trim() || !fullName.trim() || !email.trim()}>
            {t("invite.confirm")}
          </Button>
        </>
      }
    >
      <Input label={t("invite.emailLabel")} name="inviteEmail" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={submitting} />
      <Input label={t("invite.legalNameLabel")} name="inviteLegalName" value={legalName} onChange={(event) => setLegalName(event.target.value)} required disabled={submitting} />
      <HintText small>{t("invite.legalNameHint")}</HintText>
      <Input label={t("invite.fullNameLabel")} name="inviteFullName" value={fullName} onChange={(event) => setFullName(event.target.value)} required disabled={submitting} />
      <HintText small>{t("invite.shortNameHint")}</HintText>
      <Select
        label={t("invite.roleLabel")}
        name="inviteRole"
        value={roleKey}
        onChange={(event) => setRoleKey(event.target.value as InviteInput["roleKey"])}
        disabled={submitting}
        options={roleOptions.map((key) => ({ value: key, label: t(`invite.role.${key}`) }))}
      />
      {departments.length > 0 ? (
        <Select label={t("announcements:departments.choose")} name="inviteDepartment" value={departmentId} onChange={(event) => setDepartmentId(event.target.value)} disabled={submitting}
          options={[{ value: "", label: t("announcements:departments.noDepartment") }, ...departments.map((d) => ({ value: d.id, label: d.name }))]} />
      ) : null}
      <ErrorText>{error}</ErrorText>
    </Modal>
  );
}
