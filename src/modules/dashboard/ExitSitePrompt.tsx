import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "../../core/context/AuthContext";
import PresenceRepository from "../../core/repositories/PresenceRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import Button from "../../components/common/Button";
import ErrorText from "../../components/common/ErrorText";

const POLL_MS = 60000;

// v2.3.43 step 12 (item 24): "You left the site - clock out?" while the
// question is open on the server (the site's policy is PROMPT or AUTO).
// "Clock me out" is the normal clock-out (location, photo); "Still working"
// stops an automatic clock-out for this time outside.
export default function ExitSitePrompt({ onClockOut }: { onClockOut: () => void }) {
  const { t } = useTranslation("dashboard");
  const { profile } = useAuth();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const check = useCallback(async () => {
    if (!profile?.id) return;
    setOpen(await PresenceRepository.pendingExitPrompt(profile.id));
  }, [profile?.id]);

  useEffect(() => {
    void check();
    const interval = window.setInterval(() => void check(), POLL_MS);
    return () => window.clearInterval(interval);
  }, [check]);

  if (!open) return null;

  const handleStillWorking = async () => {
    setSaving(true);
    setError("");
    const result = await PresenceRepository.answerExitPrompt();
    setSaving(false);
    if (!result.success) {
      setError(humanizeBackendError(result.message, t) ?? t("exitPrompt.error"));
      return;
    }
    setOpen(false);
  };

  return (
    <div role="alert" style={{ margin: "var(--space-3) 0", padding: "var(--space-3)", borderRadius: "var(--radius-md)", border: "1px solid var(--status-warning, var(--border-strong))", background: "var(--surface-app)" }}>
      <div style={{ fontSize: "var(--font-sm)", fontWeight: "var(--font-weight-semibold)", color: "var(--text-primary)" }}>{t("exitPrompt.title")}</div>
      <p style={{ margin: "var(--space-1) 0 var(--space-3)", fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{t("exitPrompt.body")}</p>
      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
        <Button size="sm" variant="danger" onClick={onClockOut} disabled={saving}>
          {t("exitPrompt.clockOut")}
        </Button>
        <Button size="sm" variant="ghost" onClick={handleStillWorking} loading={saving}>
          {t("exitPrompt.stillWorking")}
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
