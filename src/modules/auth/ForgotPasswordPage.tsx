import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import PasswordResetRepository from "../../core/repositories/PasswordResetRepository";

import Input from "../../components/common/Input";
import Button from "../../components/common/Button";
import AuthLayout from "../../components/common/AuthLayout";
import styles from "../../components/common/AuthLayout.module.css";

// PROSM Time - live UX review, user-directed: "there should be a
// password-reset feature." The forgotten-password user's own entry
// point from Login's "Forgot password?" link - no session exists yet,
// same posture as AcceptInvitationPage. Always shows the same generic
// success message regardless of whether the email exists (§
// request-password-reset's own no-enumeration design), then hands off
// to ResetPasswordPage to enter the emailed code + new password.
export default function ForgotPasswordPage() {
  const { t } = useTranslation("auth");
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");

    const result = await PasswordResetRepository.requestReset(email.trim());

    setSubmitting(false);

    if (!result.success) {
      setError(result.message ?? t("forgotPassword.genericError"));
      return;
    }

    setSubmitted(true);
  };

  const handleContinue = () => {
    navigate(`/reset-password?email=${encodeURIComponent(email.trim())}`);
  };

  return (
    <AuthLayout title={t("forgotPassword.title")} subtitle={t("forgotPassword.subtitle")}>
      {submitted ? (
        <>
          <p className={styles.successText}>{t("forgotPassword.successMessage")}</p>
          <Button type="button" fullWidth onClick={handleContinue}>
            {t("forgotPassword.continueAction")}
          </Button>
        </>
      ) : (
        <form onSubmit={handleSubmit}>
          <Input label={t("login.emailLabel")} name="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={submitting} autoComplete="email" />

          {error ? <p className={styles.errorText}>{error}</p> : null}

          <Button type="submit" fullWidth loading={submitting}>
            {t("forgotPassword.submitAction")}
          </Button>
        </form>
      )}

      <button type="button" className={styles.textLink} onClick={() => navigate("/login")}>
        {t("forgotPassword.backToLogin")}
      </button>
    </AuthLayout>
  );
}
