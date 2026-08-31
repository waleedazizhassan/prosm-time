import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useNavigate } from "react-router-dom";

import AuthService from "../../core/auth/AuthService";
import { useAuth } from "../../core/context/AuthContext";

import Input from "../../components/common/Input";
import Button from "../../components/common/Button";

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
    <div style={{ maxWidth: 380, margin: "5rem auto", padding: "0 1rem" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "0.25rem" }}>{t("login.title")}</h1>
      <p style={{ color: "var(--text-secondary)", marginBottom: "1.5rem" }}>{t("login.subtitle")}</p>

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

        {error ? <p style={{ color: "var(--danger)", marginBottom: "1rem" }}>{error}</p> : null}

        <Button type="submit" fullWidth loading={submitting}>
          {t("login.submitAction")}
        </Button>
      </form>

      <p style={{ marginTop: "1.5rem", color: "var(--text-secondary)", fontSize: "0.9rem" }}>
        {t("login.noAccount")} <Link to="/activate" style={{ color: "var(--accent-light)" }}>{t("login.goToActivation")}</Link>
      </p>
    </div>
  );
}
