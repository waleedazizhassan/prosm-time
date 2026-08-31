import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import InvitationRepository from "../../core/repositories/InvitationRepository";
import AuthService from "../../core/auth/AuthService";

import Input from "../../components/common/Input";
import Button from "../../components/common/Button";
import BrandMark from "../../components/common/BrandMark";

// PROSM Time Implementation Master File V3.0, WP-04/§12 - the invited
// employee's own onboarding entry point. No session exists yet, same
// posture as ActivationPage. Real server-side verification happens in
// redeem-invitation.
export default function AcceptInvitationPage() {
  const { t } = useTranslation("auth");
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
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
    <div style={{ maxWidth: 420, margin: "4rem auto", padding: "0 1rem" }}>
      <div style={{ marginBottom: "1.5rem" }}>
        <BrandMark size={48} />
      </div>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "0.25rem" }}>{t("acceptInvitation.title")}</h1>
      <p style={{ color: "var(--text-secondary)", marginBottom: "1.5rem" }}>{t("acceptInvitation.subtitle")}</p>

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

        {error ? <p style={{ color: "var(--danger)", marginBottom: "1rem" }}>{error}</p> : null}
        {success ? <p style={{ color: "var(--success)", marginBottom: "1rem" }}>{t("activation.successMessage")}</p> : null}

        <Button type="submit" fullWidth loading={submitting} disabled={success}>
          {t("activation.submitAction")}
        </Button>
      </form>
    </div>
  );
}
