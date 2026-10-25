import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import DatabaseManager from "../../core/database/DatabaseManager";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import { formatDateOnly, formatTimeOnly } from "../../core/utils/formatDate";

import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import Modal from "../../components/common/Modal";
import Textarea from "../../components/common/Textarea";
import ListRow from "../../components/common/ListRow";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";

interface IntegrityFlag {
  id: string;
  user_id: string;
  employee_name: string;
  site_name: string | null;
  kind: string;
  details: Record<string, unknown>;
  created_at: string;
  occurred_at: string | null;
}

type Action = "approved" | "rejected" | "clarification_requested";

// v2.3.43 step 11 (item 22): "suspicious check-in" - a failed or skipped
// liveness challenge, a photo from a file, a stale or reused photo token,
// near-zero GPS accuracy or the same coordinates again. None of these
// blocked the clock in/out; the manager accepts, rejects or asks about each
// (a reason is required to reject or ask). Server-checked and audited.
export default function IntegrityFlagsCard() {
  const { t, i18n } = useTranslation("manager");
  const [flags, setFlags] = useState<IntegrityFlag[]>([]);
  const [target, setTarget] = useState<IntegrityFlag | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const { data, error: loadError } = await DatabaseManager.getClient().rpc("list_prosm_time_integrity_flags", { p_status: "pending_review" });
    if (loadError) setError(humanizeBackendError(loadError.message, t) ?? t("integrity.loadError"));
    setFlags((data ?? []) as IntegrityFlag[]);
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (action: Action) => {
    if (!target) return;
    setBusy(action);
    setError("");
    const { error: reviewError } = await DatabaseManager.getClient().rpc("review_prosm_time_integrity_flag", { p_flag_id: target.id, p_action: action, p_notes: notes.trim() || null });
    setBusy(null);
    if (reviewError) {
      setError(humanizeBackendError(reviewError.message, t) ?? t("integrity.genericError"));
      return;
    }
    setTarget(null);
    await load();
  };

  if (flags.length === 0) return null;
  const when = (iso: string) => `${formatDateOnly(iso, i18n.language)} ${formatTimeOnly(iso, i18n.language)}`;

  return (
    <Card title={t("integrity.title", { count: flags.length })}>
      <HintText small>{t("integrity.hint")}</HintText>
      {flags.map((flag) => (
        <ListRow key={flag.id}>
          <div>
            <div style={{ fontSize: "var(--font-sm)", fontWeight: "var(--font-weight-semibold)", color: "var(--text-primary)" }}>
              {flag.employee_name} — {t(`integrity.kind.${flag.kind}`, { defaultValue: flag.kind })}
            </div>
            <div style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
              {[flag.site_name, when(flag.occurred_at ?? flag.created_at)].filter(Boolean).join(" · ")}
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => { setTarget(flag); setNotes(""); setError(""); }}>
            {t("pending.reviewAction")}
          </Button>
        </ListRow>
      ))}
      <Modal
        isOpen={Boolean(target)}
        onClose={() => setTarget(null)}
        title={target ? `${target.employee_name} — ${t(`integrity.kind.${target.kind}`, { defaultValue: target.kind })}` : ""}
        footer={
          <>
            {(["approved", "clarification_requested", "rejected"] as Action[]).map((action) => (
              <Button key={action} variant={action === "approved" ? "primary" : action === "rejected" ? "danger" : "ghost"} loading={busy === action} onClick={() => void decide(action)}>
                {t(`pending.action.${action}`)}
              </Button>
            ))}
          </>
        }
      >
        {target ? <HintText small>{t(`integrity.explain.${target.kind}`, { defaultValue: "" })}</HintText> : null}
        <Textarea label={t("integrity.notesLabel")} name="integrityNotes" value={notes} onChange={(event) => setNotes(event.target.value)} />
        <ErrorText>{error}</ErrorText>
      </Modal>
    </Card>
  );
}
