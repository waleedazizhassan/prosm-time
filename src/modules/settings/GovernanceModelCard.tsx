import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeftRight, Building2, CheckCircle2, GitMerge, Network, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { requireSupabaseClient } from "../../core/api/supabaseClient";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import Button from "../../components/common/Button";
import Card from "../../components/common/Card";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import Modal from "../../components/common/Modal";
import SuccessText from "../../components/common/SuccessText";

type Mode = "direct" | "decentralized" | "centralized" | "two_step";
type Kind = "leave" | "permission" | "correction";
const MODES: { id: Mode; icon: LucideIcon }[] = [
  { id: "direct", icon: ArrowLeftRight },
  { id: "decentralized", icon: Network },
  { id: "centralized", icon: Building2 },
  { id: "two_step", icon: GitMerge },
];
const KINDS: Kind[] = ["leave", "permission", "correction"];
const SECTIONS = ["perms", "flow", "life"] as const;

interface Overview {
  modes: Record<Kind, Mode>;
  hrApprovers: number;
  siteManagers: number;
  departmentManagers: number;
}

// Phase F (owner 2026-11-16): "a button in a clear place that puts the organisation on the governance model we want -
// centralised, decentralised or combined - with how each works, its permissions, workflow and life cycle".
// One choice sets leave, attendance permissions and corrections together; fine tuning per kind is folded below.
// Sensitive matters stay with the owner whatever is chosen (the server enforces all of it).
export default function GovernanceModelCard() {
  const { t, i18n } = useTranslation("settings");
  const arrow = i18n.dir() === "rtl" ? "←" : "→";
  const [overview, setOverview] = useState<Overview | null>(null);
  const [shown, setShown] = useState<Mode>("direct");
  const [confirming, setConfirming] = useState<Mode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    const { data, error: e } = await requireSupabaseClient().rpc("get_prosm_time_governance_overview");
    if (e || !data) return;
    const next = data as Overview;
    setOverview(next);
    const all = KINDS.map((k) => next.modes[k]);
    setShown(all.every((m) => m === all[0]) ? all[0] : next.modes.leave);
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (!overview) return null;

  const modes = KINDS.map((k) => overview.modes[k]);
  const current: Mode | "custom" = modes.every((m) => m === modes[0]) ? modes[0] : "custom";

  const warning = (m: Mode) => {
    if ((m === "centralized" || m === "two_step") && overview.hrApprovers === 0) return t("governance.needHr");
    if (m === "decentralized" && overview.siteManagers + overview.departmentManagers === 0) return t("governance.needManagers");
    return null;
  };

  const apply = async (m: Mode) => {
    setBusy(true);
    setError("");
    setSaved(false);
    const { error: e } = await requireSupabaseClient().rpc("set_prosm_time_governance_model", { p_mode: m });
    setBusy(false);
    if (e) return setError(humanizeBackendError(e.message, t) ?? t("governance.failed"));
    setConfirming(null);
    setSaved(true);
    await load();
  };

  const setKind = async (kind: Kind, m: Mode) => {
    setError("");
    setSaved(false);
    const { error: e } = await requireSupabaseClient().rpc("set_prosm_time_approval_mode", { p_kind: kind, p_mode: m });
    if (e) return setError(humanizeBackendError(e.message, t) ?? t("governance.failed"));
    setSaved(true);
    await load();
  };

  const list = (mode: Mode, section: (typeof SECTIONS)[number]) =>
    Object.values(t(`governance.modes.${mode}.${section}`, { returnObjects: true }) as Record<string, string>);

  return (
    <Card title={t("governance.title")} subtitle={t("governance.subtitle")}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap", marginBottom: "var(--space-3)" }}>
        <span style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{t("governance.current")}</span>
        <strong style={{ padding: "2px 10px", borderRadius: 999, background: "var(--brand-primary)", color: "var(--text-on-brand, #fff)", fontSize: "var(--font-sm)" }}>
          {current === "custom" ? t("governance.custom") : t(`governance.modes.${current}.title`)}
        </strong>
        <span style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t("governance.appliesTo")}</span>
      </div>

      {/* the four models: pick one to read it, choose it with its button */}
      <div role="tablist" aria-label={t("governance.title")} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(13rem, 1fr))", gap: "var(--space-2)" }}>
        {MODES.map(({ id, icon: Icon }) => {
          const isShown = shown === id;
          const isCurrent = current === id;
          return (
            <button key={id} type="button" role="tab" aria-selected={isShown} onClick={() => setShown(id)}
              style={{ all: "unset", cursor: "pointer", boxSizing: "border-box", padding: "var(--space-3)", borderRadius: "var(--radius-md)",
                border: `${isShown ? 2 : 1}px solid ${isShown ? "var(--brand-primary)" : "var(--border-light)"}`, display: "grid", gap: 4 }}>
              <span style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                <Icon size={18} aria-hidden="true" color="var(--brand-primary)" />
                <strong style={{ fontSize: "var(--font-sm)" }}>{t(`governance.modes.${id}.title`)}</strong>
                {isCurrent ? <CheckCircle2 size={16} aria-label={t("governance.active")} color="var(--status-success-text)" /> : null}
              </span>
              <span style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t(`governance.modes.${id}.tagline`)}</span>
            </button>
          );
        })}
      </div>

      {/* the chosen model, explained */}
      <section role="tabpanel" style={{ marginTop: "var(--space-3)", padding: "var(--space-3)", borderRadius: "var(--radius-md)", background: "var(--surface-muted, var(--bg-secondary))" }}>
        <p style={{ margin: "0 0 var(--space-2)", fontSize: "var(--font-sm)" }}>{t(`governance.modes.${shown}.how`)}</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(14rem, 1fr))", gap: "var(--space-3)" }}>
          {SECTIONS.map((section) => (
            <div key={section}>
              <strong style={{ display: "block", fontSize: "var(--font-sm)", marginBottom: 4 }}>{t(`governance.sections.${section}`)}</strong>
              {section === "perms" ? (
                <ul style={{ margin: 0, paddingInlineStart: "1.1rem", fontSize: "var(--font-sm)", display: "grid", gap: 2 }}>
                  {list(shown, section).map((line) => <li key={line}>{line}</li>)}
                </ul>
              ) : section === "flow" ? (
                <ol style={{ margin: 0, paddingInlineStart: "1.1rem", fontSize: "var(--font-sm)", display: "grid", gap: 2 }}>
                  {list(shown, section).map((line) => <li key={line}>{line}</li>)}
                </ol>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, fontSize: "var(--font-xs)" }}>
                  {list(shown, section).map((state, i, all) => (
                    <span key={state} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <span style={{ padding: "2px 8px", borderRadius: 999, border: "1px solid var(--border-light)" }}>{state}</span>
                      {i < all.length - 1 ? <span aria-hidden="true">{arrow}</span> : null}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        <HintText small>{t(`governance.modes.${shown}.fits`)}</HintText>
        {warning(shown) ? <p role="alert" style={{ margin: "var(--space-2) 0 0", color: "var(--status-warning-text)", fontSize: "var(--font-sm)" }}>{warning(shown)}</p> : null}
        <div style={{ marginTop: "var(--space-3)" }}>
          {current === shown ? (
            <span style={{ color: "var(--status-success-text)", fontSize: "var(--font-sm)", display: "inline-flex", gap: 6, alignItems: "center" }}>
              <CheckCircle2 size={16} aria-hidden="true" /> {t("governance.isActive")}
            </span>
          ) : (
            <Button onClick={() => { setError(""); setConfirming(shown); }}>{t("governance.use")}</Button>
          )}
        </div>
      </section>

      {/* always, in every model */}
      <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-3)", fontSize: "var(--font-sm)" }}>
        <ShieldCheck size={18} aria-hidden="true" color="var(--brand-primary)" style={{ flexShrink: 0 }} />
        <div>
          <strong>{t("governance.alwaysTitle")}</strong>
          <ul style={{ margin: "4px 0 0", paddingInlineStart: "1.1rem", display: "grid", gap: 2 }}>
            {Object.values(t("governance.always", { returnObjects: true }) as Record<string, string>).map((line) => <li key={line}>{line}</li>)}
          </ul>
        </div>
      </div>

      {/* fine tuning: a different model per kind */}
      <details style={{ marginTop: "var(--space-3)" }}>
        <summary style={{ cursor: "pointer", fontSize: "var(--font-sm)" }}>{t("governance.perKind")}</summary>
        <div style={{ display: "grid", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
          {KINDS.map((kind) => (
            <label key={kind} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--font-sm)" }}>
              <span>{t(`governance.kinds.${kind}`)}</span>
              <select value={overview.modes[kind]} onChange={(e) => void setKind(kind, e.target.value as Mode)}
                style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid var(--border-light)", background: "var(--bg-primary)", color: "var(--text-primary)" }}>
                {MODES.map(({ id }) => <option key={id} value={id}>{t(`governance.modes.${id}.title`)}</option>)}
              </select>
            </label>
          ))}
        </div>
      </details>

      <ErrorText>{error}</ErrorText>
      {saved ? <SuccessText>{t("governance.saved")}</SuccessText> : null}

      <Modal isOpen={confirming !== null} onClose={() => setConfirming(null)} size="sm"
        title={t("governance.confirmTitle")}
        footer={<Button fullWidth loading={busy} onClick={() => confirming && void apply(confirming)}>{t("governance.confirm")}</Button>}>
        {confirming ? (
          <>
            <strong style={{ display: "block", marginBottom: 4 }}>{t(`governance.modes.${confirming}.title`)}</strong>
            <HintText>{t(`governance.modes.${confirming}.how`)}</HintText>
            <HintText small>{t("governance.confirmNote")}</HintText>
            {warning(confirming) ? <p role="alert" style={{ color: "var(--status-warning-text)", fontSize: "var(--font-sm)" }}>{warning(confirming)}</p> : null}
          </>
        ) : null}
        <ErrorText>{error}</ErrorText>
      </Modal>
    </Card>
  );
}
