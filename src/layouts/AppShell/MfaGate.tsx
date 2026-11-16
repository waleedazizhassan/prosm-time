import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ShieldCheck } from "lucide-react";

import { getSupabaseClient } from "../../core/api/supabaseClient";
import AuthService from "../../core/auth/AuthService";
import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";
import Input from "../../components/common/Input";

// Owner 2026-11-17 ("I turned on two-step verification, signed out and in - it asked for nothing"): a person who
// turned two-step sign-in on enters the authenticator code after the password, before anything opens. Supabase
// says so itself: nextLevel aal2 while the session is still aal1.
export default function MfaGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation("common");
  const [state, setState] = useState<"checking" | "needed" | "ok">("checking");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    const client = getSupabaseClient();
    if (!client) { setState("ok"); return undefined; }
    void client.auth.mfa.getAuthenticatorAssuranceLevel().then(({ data }) => {
      if (!alive) return;
      setState(data && data.nextLevel === "aal2" && data.currentLevel !== "aal2" ? "needed" : "ok");
    }, () => alive && setState("ok"));
    return () => { alive = false; };
  }, []);

  if (state === "ok") return <>{children}</>;
  if (state === "checking") return null;

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    const client = getSupabaseClient();
    if (!client) return;
    setBusy(true);
    setError("");
    const { data: factors } = await client.auth.mfa.listFactors();
    const factor = (factors?.totp ?? []).find((item) => item.status === "verified");
    const verified = factor ? await client.auth.mfa.challengeAndVerify({ factorId: factor.id, code: code.trim() }) : null;
    setBusy(false);
    if (!verified || verified.error) {
      setError(t("mfaGate.wrong"));
      return;
    }
    setState("ok");
  };

  return (
    <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: "var(--space-4)", background: "var(--bg-primary)" }}>
      <form onSubmit={verify} style={{ width: "min(420px, 100%)", display: "grid", gap: "var(--space-3)", padding: "var(--space-5)",
        borderRadius: "var(--radius-lg)", border: "1px solid var(--border-light)", background: "var(--surface-card)" }}>
        <ShieldCheck size={36} color="var(--brand-primary)" aria-hidden="true" />
        <h1 style={{ margin: 0, fontSize: "var(--font-xl)" }}>{t("mfaGate.title")}</h1>
        <p style={{ margin: 0, color: "var(--text-secondary)" }}>{t("mfaGate.explain")}</p>
        <Input label={t("mfaGate.code")} name="mfaCode" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric" autoComplete="one-time-code" required />
        <ErrorText>{error}</ErrorText>
        <Button type="submit" loading={busy} disabled={code.length !== 6}>{t("mfaGate.confirm")}</Button>
        <Button type="button" variant="ghost" onClick={() => void AuthService.signOut().then(() => window.location.assign("/login"))}>{t("mfaGate.signOut")}</Button>
      </form>
    </div>
  );
}
