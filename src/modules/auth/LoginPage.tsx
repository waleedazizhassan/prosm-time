import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useNavigate } from "react-router-dom";

import AuthService from "../../core/auth/AuthService";
import { useAuth } from "../../core/context/AuthContext";

import Input from "../../components/common/Input";
import Button from "../../components/common/Button";
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

  return (
    <AuthLayout
      title={t("login.title")}
      subtitle={t("login.subtitle")}
      footer={
        <>
          {t("login.noAccount")} <Link to="/activate">{t("login.goToActivation")}</Link>
        </>
      }
    >
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
    </AuthLayout>
  );
}
