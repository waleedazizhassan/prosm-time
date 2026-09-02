import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import InvitationRepository from "../../core/repositories/InvitationRepository";
import AuthService from "../../core/auth/AuthService";

import Input from "../../components/common/Input";
import Button from "../../components/common/Button";
import AuthLayout from "../../components/common/AuthLayout";
import styles from "../../components/common/AuthLayout.module.css";

// PROSM Time Implementation Master File V3.0, WP-04/§12 - the invited
// employee's own onboarding entry point. No session exists yet, same
// posture as ActivationPage. Real server-side verification happens in
// redeem-invitation.
export default function AcceptInvitationPage() {
  const { t } = useTranslation("auth");
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // The invitation link an admin shares (InviteEmployeeModal) carries
  // ?email=&code= so the employee never has to type either by hand -
  // both stay editable in case the link was forwarded/mistyped.
  const [email, setEmail] = useState(searchParams.get("email") ?? "");
  const [verificationCode, setVerificationCode] = useState(searchParams.get("code") ?? "");
  const [newPassword, setNewPassword] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");

    const result = await InvitationRepository.redeemInvitation({
      email: email.trim(),
      verificationCode: verificationCode.trim(),
      newPassword,
    });

    if (!result.success) {
      setSubmitting(false);
      setError(result.message ?? t("activation.genericError"));
      return;
    }

    setSuccess(true);

    const signInResult = await AuthService.signIn(email.trim(), newPassword);
    setSubmitting(false);

    if (signInResult.success) {
      navigate("/dashboard", { replace: true });
    } else {
      navigate("/login", { replace: true });
    }
  };

  return (
    <AuthLayout
      title={t("acceptInvitation.title")}
      subtitle={t("acceptInvitation.subtitle")}
      footer={
        <>
          {t("acceptInvitation.alreadyHaveAccount")} <Link to="/login">{t("activation.goToLogin")}</Link>
        </>
      }
    >
      <form onSubmit={handleSubmit}>
        <Input label={t("login.emailLabel")} name="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={submitting || success} autoComplete="email" />
        <Input
          label={t("acceptInvitation.verificationCodeLabel")}
          name="verificationCode"
          value={verificationCode}
          onChange={(event) => setVerificationCode(event.target.value)}
          required
          disabled={submitting || success}
        />
        <Input
          label={t("activation.ownerPasswordLabel")}
          name="newPassword"
          type="password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          required
          disabled={submitting || success}
          helperText={t("activation.passwordHelper")}
          autoComplete="new-password"
        />

        {error ? <p className={styles.errorText}>{error}</p> : null}
        {success ? <p className={styles.successText}>{t("activation.successMessage")}</p> : null}

        <Button type="submit" fullWidth loading={submitting} disabled={success}>
          {t("activation.submitAction")}
        </Button>
      </form>
    </AuthLayout>
  );
}
