import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { requireSupabaseClient } from "../../core/api/supabaseClient";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import Card from "../../components/common/Card";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import SuccessText from "../../components/common/SuccessText";

type Mode = "direct" | "decentralized" | "centralized" | "two_step";
const MODES: Mode[] = ["direct", "decentralized", "centralized", "two_step"];

// Phase F (owner approved 2026-11-16): how the organisation's leave requests are decided. Sensitive matters (payroll,
// permissions, billing, keys, ownership) stay with the owner whatever is chosen. Hidden until the server has it.
export default function ApprovalModesCard() {
  const { t } = useTranslation("settings");
  const [mode, setMode] = useState<Mode | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void requireSupabaseClient().rpc("get_prosm_time_approval_modes").then(({ data, error: e }) => {
      if (!e && data) setMode(((data as { leave?: Mode }).leave ?? "direct") as Mode);
    });
  }, []);
  if (!mode) return null;

  const choose = async (next: Mode) => {
    setError("");
    setSaved(false);
    const { error: e } = await requireSupabaseClient().rpc("set_prosm_time_approval_mode", { p_kind: "leave", p_mode: next });
    if (e) {
      setError(humanizeBackendError(e.message, t) ?? t("approvalModes.failed"));
      return;
    }
    setMode(next);
    setSaved(true);
  };

  return (
    <Card title={t("approvalModes.title")} subtitle={t("approvalModes.subtitle")}>
      <div role="radiogroup" aria-label={t("approvalModes.title")} style={{ display: "grid", gap: "var(--space-2)" }}>
        {MODES.map((m) => (
          <label key={m} style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-start", cursor: "pointer", padding: "8px 10px", borderRadius: 12,
            border: `1px solid ${mode === m ? "var(--brand-primary)" : "var(--border-light)"}` }}>
            <input type="radio" name="leaveApprovalMode" checked={mode === m} onChange={() => void choose(m)} style={{ marginTop: 4 }} />
            <span>
              <b>{t(`approvalModes.${m}.title`)}</b>
              <HintText small>{t(`approvalModes.${m}.hint`)}</HintText>
            </span>
          </label>
        ))}
      </div>
      <HintText small>{t("approvalModes.sources")}</HintText>
      <ErrorText>{error}</ErrorText>
      {saved ? <SuccessText>{t("approvalModes.saved")}</SuccessText> : null}
    </Card>
  );
}
