import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";

import ActivationRepository from "../../core/repositories/ActivationRepository";
import AuthService from "../../core/auth/AuthService";

import Input from "../../components/common/Input";
import Button from "../../components/common/Button";
import BrandMark from "../../components/common/BrandMark";

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
    <div style={{ maxWidth: 420, margin: "4rem auto", padding: "0 1rem" }}>
      <div style={{ marginBottom: "1.5rem" }}>
        <BrandMark size={48} />
      </div>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "0.25rem" }}>{t("activation.title")}</h1>
      <p style={{ color: "var(--text-secondary)", marginBottom: "1.5rem" }}>{t("activation.subtitle")}</p>

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

        {error ? <p style={{ color: "var(--danger)", marginBottom: "1rem" }}>{error}</p> : null}
        {success ? <p style={{ color: "var(--success)", marginBottom: "1rem" }}>{t("activation.successMessage")}</p> : null}

        <Button type="submit" fullWidth loading={submitting} disabled={success}>
          {t("activation.submitAction")}
        </Button>
      </form>

      <p style={{ marginTop: "1.5rem", color: "var(--text-secondary)", fontSize: "0.9rem" }}>
        {t("activation.alreadyHaveAccount")} <Link to="/login" style={{ color: "var(--accent-light)" }}>{t("activation.goToLogin")}</Link>
      </p>
    </div>
  );
}
