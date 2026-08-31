import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate } from "react-router-dom";

import AuthService from "../../core/auth/AuthService";
import { useAuth } from "../../core/context/AuthContext";

import Input from "../../components/common/Input";
import Button from "../../components/common/Button";
import Divider from "../../components/common/Divider";
import AuthLayout from "../../components/common/AuthLayout";
import styles from "../../components/common/AuthLayout.module.css";

// PROSM Time Implementation Master File V3.0, WP-03/§12/§37 - "secure
// authentication." Plain Supabase Auth email/password sign-in - the
// real identity fact (organization, role) is read separately by
// AuthContext once a session exists, never assumed from this form.
export default function LoginPage() {
  const { t } = useTranslation("auth");
  const navigate = useNavigate();
  const { isAuthenticated, loading } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  if (!loading && isAuthenticated) {
    return <Navigate to="/dashboard" replace />;
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");

    const result = await AuthService.signIn(email.trim(), password);

    setSubmitting(false);

    if (!result.success) {
      setError(result.message ?? t("login.genericError"));
      return;
    }

    navigate("/dashboard", { replace: true });
  };

  // §12/§37 "new user" entry points - same placement/wording/behavior
  // as PROSM Platform's own Login.jsx (Divider("or") + hint +
  // outlined secondary button + plain text link below the form).
  // "Activate license" maps to organization activation (this
  // product's equivalent of Platform's /bootstrap); "Activate your
  // account" maps to redeeming an employee invitation (this product's
  // equivalent of Platform's /verify-reset?mode=activation) - both are
  // first-access flows for someone with no session yet, kept as two
  // distinct destinations exactly like Platform keeps them distinct.
  const handleActivateLicense = () => {
    navigate("/activate");
  };

  const handleActivateAccount = () => {
    navigate("/accept-invitation");
  };

  return (
    <AuthLayout title={t("login.title")} subtitle={t("login.subtitle")}>
      <form onSubmit={handleSubmit}>
        <Input
          label={t("login.emailLabel")}
          name="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          disabled={submitting}
          autoComplete="email"
        />
        <Input
          label={t("login.passwordLabel")}
          name="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          disabled={submitting}
          autoComplete="current-password"
        />

        {error ? <p className={styles.errorText}>{error}</p> : null}

        <Button type="submit" fullWidth loading={submitting}>
          {t("login.submitAction")}
        </Button>
      </form>

      <Divider label={t("login.orDivider")} />

      <p className={styles.hint}>{t("login.newOrganizationHint")}</p>

      <button type="button" className={styles.secondaryButton} onClick={handleActivateLicense}>
        {t("login.activateLicense")}
      </button>

      <button type="button" className={styles.textLink} onClick={handleActivateAccount}>
        {t("login.activateAccount")}
      </button>
    </AuthLayout>
  );
}
