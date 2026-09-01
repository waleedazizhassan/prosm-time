import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";

import PasswordResetRepository from "../../core/repositories/PasswordResetRepository";
import AuthService from "../../core/auth/AuthService";

import Input from "../../components/common/Input";
import Button from "../../components/common/Button";
import AuthLayout from "../../components/common/AuthLayout";
import styles from "../../components/common/AuthLayout.module.css";

// PROSM Time - live UX review, user-directed password-reset feature.
// Reached from ForgotPasswordPage or directly from the emailed link
// (?email=&code=), same "link pre-fills, both stay editable" pattern
// as AcceptInvitationPage. Real verification always happens server-
// side in reset-password.
export default function ResetPasswordPage() {
  const { t } = useTranslation("auth");
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [email, setEmail] = useState(searchParams.get("email") ?? "");
  const [verificationCode, setVerificationCode] = useState(searchParams.get("code") ?? "");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");

    if (newPassword !== confirmPassword) {
      setError(t("resetPassword.mismatchError"));
      return;
    }

    setSubmitting(true);

    const result = await PasswordResetRepository.resetPassword({
      email: email.trim(),
      verificationCode: verificationCode.trim(),
      newPassword,
    });

    if (!result.success) {
      setSubmitting(false);
      setError(result.message ?? t("resetPassword.genericError"));
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
    <AuthLayout title={t("resetPassword.title")} subtitle={t("resetPassword.subtitle")}>
      <form onSubmit={handleSubmit}>
        <Input label={t("login.emailLabel")} name="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={submitting || success} autoComplete="email" />
        <Input
          label={t("resetPassword.verificationCodeLabel")}
          name="verificationCode"
          value={verificationCode}
          onChange={(event) => setVerificationCode(event.target.value)}
          required
          disabled={submitting || success}
        />
        <Input
          label={t("resetPassword.newPasswordLabel")}
          name="newPassword"
          type="password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          required
          disabled={submitting || success}
          helperText={t("resetPassword.passwordHelper")}
          autoComplete="new-password"
        />
        <Input
          label={t("resetPassword.confirmPasswordLabel")}
          name="confirmPassword"
          type="password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          required
          disabled={submitting || success}
          autoComplete="new-password"
        />

        {error ? <p className={styles.errorText}>{error}</p> : null}
        {success ? <p className={styles.successText}>{t("resetPassword.successMessage")}</p> : null}

        <Button type="submit" fullWidth loading={submitting} disabled={success}>
          {t("resetPassword.submitAction")}
        </Button>
      </form>

      <button type="button" className={styles.textLink} onClick={() => navigate("/login")}>
        {t("forgotPassword.backToLogin")}
      </button>
    </AuthLayout>
  );
}
