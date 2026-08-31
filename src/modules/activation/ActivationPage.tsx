import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";

import ActivationRepository from "../../core/repositories/ActivationRepository";
import AuthService from "../../core/auth/AuthService";

import Input from "../../components/common/Input";
import Button from "../../components/common/Button";
import AuthLayout from "../../components/common/AuthLayout";
import styles from "../../components/common/AuthLayout.module.css";

// PROSM Time Implementation Master File V3.0, WP-03/§37 - "Activation /
// Welcome." The one screen a brand-new customer reaches with no session
// at all. Real server-side verification happens in
// activate-organization (§5) - this component only collects input and
// reports the real result, never decides activation success itself.
export default function ActivationPage() {
  const { t } = useTranslation("auth");
  const navigate = useNavigate();

  const [activationCode, setActivationCode] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [ownerFullName, setOwnerFullName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");

    const result = await ActivationRepository.activateOrganization({
      activationCode: activationCode.trim(),
      organizationName: organizationName.trim(),
      ownerEmail: ownerEmail.trim(),
      ownerPassword,
      ownerFullName: ownerFullName.trim(),
    });

    if (!result.success) {
      setSubmitting(false);
      setError(result.message ?? t("activation.genericError"));
      return;
    }

    setSuccess(true);

    // The Owner's password is real and already known here - sign them
    // in immediately rather than sending them back to a second login
    // screen for a credential they just typed once (createUser on the
    // server does not itself establish a client session).
    const signInResult = await AuthService.signIn(ownerEmail.trim(), ownerPassword);
    setSubmitting(false);

    if (signInResult.success) {
      navigate("/dashboard", { replace: true });
    } else {
      navigate("/login", { replace: true });
    }
  };

  return (
    <AuthLayout
      title={t("activation.title")}
      subtitle={t("activation.subtitle")}
      footer={
        <>
          {t("activation.alreadyHaveAccount")} <Link to="/login">{t("activation.goToLogin")}</Link>
        </>
      }
    >
      <form onSubmit={handleSubmit}>
        <Input
          label={t("activation.activationCodeLabel")}
          name="activationCode"
          value={activationCode}
          onChange={(event) => setActivationCode(event.target.value)}
          required
          disabled={submitting || success}
        />
        <Input
          label={t("activation.organizationNameLabel")}
          name="organizationName"
          value={organizationName}
          onChange={(event) => setOrganizationName(event.target.value)}
          required
          disabled={submitting || success}
        />
        <Input
          label={t("activation.ownerFullNameLabel")}
          name="ownerFullName"
          value={ownerFullName}
          onChange={(event) => setOwnerFullName(event.target.value)}
          required
          disabled={submitting || success}
        />
        <Input
          label={t("activation.ownerEmailLabel")}
          name="ownerEmail"
          type="email"
          value={ownerEmail}
          onChange={(event) => setOwnerEmail(event.target.value)}
          required
          disabled={submitting || success}
          autoComplete="email"
        />
        <Input
          label={t("activation.ownerPasswordLabel")}
          name="ownerPassword"
          type="password"
          value={ownerPassword}
          onChange={(event) => setOwnerPassword(event.target.value)}
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
