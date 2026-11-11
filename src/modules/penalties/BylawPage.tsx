import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router-dom";
import { Plus, Trash2 } from "lucide-react";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Toggle from "../../components/common/Toggle";
import Modal from "../../components/common/Modal";
import StatusBadge from "../../components/common/StatusBadge";
import ErrorText from "../../components/common/ErrorText";
import SuccessText from "../../components/common/SuccessText";
import HintText from "../../components/common/HintText";
import LoadingState from "../../components/common/LoadingState";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import { formatDateOnly, formatDateTime } from "../../core/utils/formatDate";
import { useAuth } from "../../core/context/AuthContext";
import PenaltiesRepository, {
  type AmountType, type Bylaw, type IncentiveRule, type LadderStep, type Level, type PenaltyActionType, type ViolationSource, type ViolationType,
} from "../../core/repositories/PenaltiesRepository";
import { actionText, actionTypeName, incentiveValueText, violationName } from "./penaltyUi";

const SOURCES: ViolationSource[] = ["attendance_late", "attendance_early_leave", "attendance_absent", "geofence_exit", "manual"];
const LEVELS: Level[] = ["manager", "hr", "owner"];
const today = () => new Date().toLocaleDateString("en-CA");

type TypeDraft = Omit<ViolationType, "id"> & { id: string | null };
type ActionDraft = PenaltyActionType & { isNew?: boolean };
type RuleDraft = Omit<IncentiveRule, "id"> & { id: string | null };

// HR suite feature 1: the company's penalties bylaw. Everything here is the company's own choice - PROSM
// writes no legal value. The draft is edited freely; "Publish" makes a new version from a date (older
// violations keep the rule they were recorded under) and posts it in the Media Center to be read.
export default function BylawPage() {
  const { t, i18n } = useTranslation("penalties");
  const { profile, hasPermission } = useAuth();
  const isAdmin = Boolean(profile?.isOwner) || hasPermission("hr.manage");
  const [b, setB] = useState<Bylaw | null>(null);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [levels, setLevels] = useState<Level[]>(["hr"]);
  const [ack, setAck] = useState(false);
  const [typeDraft, setTypeDraft] = useState<TypeDraft | null>(null);
  const [actionDraft, setActionDraft] = useState<ActionDraft | null>(null);
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null);
  const [effective, setEffective] = useState(today());
  const [reset, setReset] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [modalError, setModalError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    const r = await PenaltiesRepository.bylaw();
    if (r.error) return setError(humanizeBackendError(r.error, t) ?? t("loadError"));
    setB(r.data);
    const s = r.data!.settings;
    setSettings({
      capUnit: s.capUnit ?? "", capDays: s.capDays?.toString() ?? "", capPercent: s.capPercent?.toString() ?? "",
      appealWindowDays: s.appealWindowDays?.toString() ?? "", maxDaysToImpose: s.maxDaysToImpose?.toString() ?? "",
    });
    setLevels(s.incentiveLevels?.length ? s.incentiveLevels : ["hr"]);
  }, [t]);

  useEffect(() => {
    if (isAdmin) void load();
  }, [load, isAdmin]);

  if (!isAdmin) return <Navigate to="/penalties" replace />;
  if (!b) return <PageShell title={t("bylaw.title")}>{error ? <ErrorText>{error}</ErrorText> : <LoadingState fullHeight />}</PageShell>;

  const run = async (key: string, task: () => Promise<{ error: string | null }>, done: string, inModal = false) => {
    setBusy(key);
    setError("");
    setModalError("");
    setNotice("");
    const r = await task();
    setBusy("");
    if (r.error) {
      const text = humanizeBackendError(r.error, t) ?? t("actionError");
      if (inModal) setModalError(text);
      else setError(text);
      return false;
    }
    setNotice(done);
    await load();
    return true;
  };

  const saveSettings = () => run("settings", () => PenaltiesRepository.saveSettings({ ...settings, incentiveLevels: levels, acknowledgeLiability: ack }), t("bylaw.saved"))
    .then((ok) => ok && setAck(false));

  const actionById = (id: string) => b.actionTypes.find((a) => a.id === id);
  const activeActions = b.actionTypes.filter((a) => a.isActive !== false);

  // the text everyone reads in the Media Center (in the publisher's language)
  const announcement = () => {
    const lines: string[] = [];
    for (const v of b.violationTypes.filter((x) => x.isActive)) {
      lines.push(`• ${violationName(t, v)}${v.thresholdMinutes != null ? ` (${t("bylaw.moreThan", { count: v.thresholdMinutes })})` : ""}`);
      for (const s of [...v.steps].sort((x, y) => x.occurrence - y.occurrence)) {
        const a = actionById(s.actionTypeId);
        lines.push(`   ${t("bylaw.stepLine", { n: s.occurrence })}: ${actionText(t, a ? { ...a, value: s.value } : undefined, i18n.language)}`);
      }
      lines.push(`   ${t("bylaw.lookbackLine", { count: v.lookbackDays })}`);
    }
    if (b.settings.appealWindowDays != null) lines.push("", t("bylaw.appealLine", { count: b.settings.appealWindowDays }));
    return { title: t("bylaw.announcementTitle", { date: formatDateOnly(effective, i18n.language) }), body: lines.join("\n") };
  };

  const publish = () => run("publish", () => PenaltiesRepository.publish(effective, reset, announcement()), t("bylaw.published"));

  const saveType = async () => {
    if (!typeDraft) return;
    const ok = await run("type", () => PenaltiesRepository.saveViolationType(typeDraft.id, {
      name: typeDraft.name, source: typeDraft.source, thresholdMinutes: typeDraft.thresholdMinutes, lookbackDays: typeDraft.lookbackDays,
      steps: typeDraft.steps.map((s, i) => ({ occurrence: i + 1, actionTypeId: s.actionTypeId, value: s.value })), isActive: typeDraft.isActive,
    }), t("bylaw.savedDraft"), true);
    if (ok) setTypeDraft(null);
  };

  const saveAction = async () => {
    if (!actionDraft) return;
    const ok = await run("action", () => PenaltiesRepository.saveActionType(actionDraft.isNew ? null : actionDraft.id, {
      name: actionDraft.name, kind: actionDraft.kind, unit: actionDraft.unit, requiresInvestigation: actionDraft.requiresInvestigation,
      requiresResponse: actionDraft.requiresResponse, responseDays: actionDraft.responseDays, levels: actionDraft.levels,
      reporterCannotApprove: actionDraft.reporterCannotApprove, autoApprove: actionDraft.autoApprove, isActive: actionDraft.isActive !== false,
    }), t("bylaw.savedDraft"), true);
    if (ok) setActionDraft(null);
  };

  const saveRule = async () => {
    if (!ruleDraft) return;
    const ok = await run("rule", () => PenaltiesRepository.saveIncentiveRule(ruleDraft.id, {
      name: ruleDraft.name, source: ruleDraft.source, amountType: ruleDraft.amountType, value: ruleDraft.value, isActive: ruleDraft.isActive,
    }), t("bylaw.saved"), true);
    if (ok) setRuleDraft(null);
  };

  const setStep = (i: number, patch: Partial<LadderStep>) =>
    typeDraft && setTypeDraft({ ...typeDraft, steps: typeDraft.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  const levelPicker = (value: Level[], onChange: (next: Level[]) => void) => (
    <div style={{ display: "grid", gap: 6 }}>
      {[0, 1, 2].map((i) => (
        <Select key={i} label={t("bylaw.levelN", { n: i + 1 })} name={`level${i}`} value={value[i] ?? ""}
          disabled={i > 0 && !value[i - 1]}
          onChange={(e) => {
            const next = [...value];
            if (e.target.value) next[i] = e.target.value as Level; else next.splice(i);
            onChange(next.filter(Boolean).filter((x, k, all) => all.indexOf(x) === k));
          }}
          options={[...(i > 0 ? [{ value: "", label: t("bylaw.noMoreLevels") }] : []), ...LEVELS.map((l) => ({ value: l, label: t(`levels.${l}`) }))]} />
      ))}
    </div>
  );

  const unitOptions = [{ value: "", label: t("bylaw.capUnits.none") }, ...(["days_per_month", "percent_of_wage", "both"] as const).map((u) => ({ value: u, label: t(`bylaw.capUnits.${u}`) }))];
  const ready = Boolean(b.settings.capUnit) && b.settings.appealWindowDays != null && Boolean(b.liability.at);

  return (
    <PageShell title={t("bylaw.title")} subtitle={b.activeVersion ? t("bylaw.activeVersion", { version: b.activeVersion }) : t("bylaw.notActive")}>
      <ErrorText>{error}</ErrorText>
      {notice ? <SuccessText>{notice}</SuccessText> : null}

      <Card title={t("bylaw.limitsTitle")}>
        <HintText>{t("bylaw.limitsHint")}</HintText>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))", gap: "var(--space-2)" }}>
          <Select label={t("bylaw.capUnit")} name="capUnit" value={settings.capUnit ?? ""} onChange={(e) => setSettings({ ...settings, capUnit: e.target.value })} options={unitOptions} />
          {settings.capUnit === "days_per_month" || settings.capUnit === "both" ? (
            <Input label={t("bylaw.capDays")} name="capDays" type="number" value={settings.capDays ?? ""} onChange={(e) => setSettings({ ...settings, capDays: e.target.value })} />
          ) : null}
          {settings.capUnit === "percent_of_wage" || settings.capUnit === "both" ? (
            <Input label={t("bylaw.capPercent")} name="capPercent" type="number" value={settings.capPercent ?? ""} onChange={(e) => setSettings({ ...settings, capPercent: e.target.value })} />
          ) : null}
          <Input label={t("bylaw.appealWindow")} name="appealWindow" type="number" value={settings.appealWindowDays ?? ""} onChange={(e) => setSettings({ ...settings, appealWindowDays: e.target.value })} />
          <Input label={t("bylaw.maxDays")} name="maxDays" type="number" value={settings.maxDaysToImpose ?? ""} onChange={(e) => setSettings({ ...settings, maxDaysToImpose: e.target.value })} />
        </div>
        <HintText small>{t("bylaw.lawNote")}</HintText>
        <h3 style={{ margin: "var(--space-3) 0 var(--space-1)" }}>{t("bylaw.incentiveLevels")}</h3>
        <div style={{ maxWidth: 360 }}>{levelPicker(levels, setLevels)}</div>
        <div style={{ marginTop: "var(--space-3)", padding: "var(--space-3)", borderRadius: "var(--radius-md)", background: "var(--status-warning-bg)", border: "1px solid var(--status-warning-border)" }}>
          <p style={{ margin: 0 }}>{t("bylaw.liability")}</p>
          {b.liability.at ? (
            <HintText small>{t("bylaw.liabilityDone", { name: b.liability.by ?? "", date: formatDateTime(b.liability.at, i18n.language) })}</HintText>
          ) : (
            <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> {t("bylaw.liabilityAgree")}
            </label>
          )}
        </div>
        <div style={{ marginTop: "var(--space-3)" }}>
          <Button loading={busy === "settings"} onClick={() => void saveSettings()}>{t("bylaw.save")}</Button>
        </div>
      </Card>

      <Card title={t("bylaw.violationsTitle")} actions={(
        <span style={{ display: "inline-flex", gap: 6 }}>
          <Button size="sm" variant="ghost" loading={busy === "template"} onClick={() => void run("template", () => PenaltiesRepository.addTemplate(), t("bylaw.templateAdded"))}>{t("bylaw.template")}</Button>
          <Button size="sm" onClick={() => { setModalError(""); setTypeDraft({ id: null, name: "", templateKey: null, source: "manual", thresholdMinutes: null, lookbackDays: 180, isActive: true, steps: [{ occurrence: 1, actionTypeId: activeActions[0]?.id ?? "", value: null }] }); }}>{t("bylaw.addViolation")}</Button>
        </span>
      )}>
        <HintText small>{t("bylaw.violationsHint")}</HintText>
        {b.violationTypes.length === 0 ? <HintText>{t("bylaw.noViolations")}</HintText> : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {b.violationTypes.map((v) => (
              <li key={v.id} style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", alignItems: "center", padding: "var(--space-2) 0", borderBottom: "1px solid var(--border-light)" }}>
                <div style={{ flex: "1 1 14rem", minWidth: 0 }}>
                  <strong>{violationName(t, v)}</strong>
                  <div style={{ color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>
                    {t(`sources.${v.source}`)}{v.thresholdMinutes != null ? ` · ${t("bylaw.moreThan", { count: v.thresholdMinutes })}` : ""} · {[...v.steps].sort((x, y) => x.occurrence - y.occurrence).map((s) => {
                      const a = actionById(s.actionTypeId);
                      return `${s.occurrence}: ${actionText(t, a ? { ...a, value: s.value } : undefined, i18n.language)}`;
                    }).join(" ← ")}
                  </div>
                </div>
                {!v.isActive ? <StatusBadge status="deactivated">{t("bylaw.draft")}</StatusBadge> : null}
                <Button size="sm" variant="ghost" onClick={() => { setModalError(""); setTypeDraft({ ...v, name: v.name ?? (v.templateKey ? t(`templates.${v.templateKey}`) : ""), steps: [...v.steps].sort((x, y) => x.occurrence - y.occurrence) }); }}>{t("bylaw.edit")}</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t("bylaw.typesTitle")} actions={<Button size="sm" variant="ghost" onClick={() => { setModalError(""); setActionDraft({ id: "", code: "", name: "", kind: "other", unit: null, requiresInvestigation: false, requiresResponse: false, responseDays: null, reporterCannotApprove: true, levels: ["hr"], autoApprove: false, isActive: true, isNew: true }); }}>{t("bylaw.addType")}</Button>}>
        <HintText small>{t("bylaw.typesHint")}</HintText>
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {b.actionTypes.map((a) => (
            <li key={a.id} style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", alignItems: "center", padding: "var(--space-2) 0", borderBottom: "1px solid var(--border-light)" }}>
              <div style={{ flex: "1 1 14rem", minWidth: 0 }}>
                <strong>{actionTypeName(t, a)}</strong>
                <div style={{ color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>
                  {[a.requiresInvestigation ? t("bylaw.needsInvestigation") : null, a.requiresResponse ? t("bylaw.needsReply", { count: a.responseDays ?? 0 }) : null,
                    a.levels.map((l) => t(`levels.${l}`)).join(" ← "), a.autoApprove ? t("bylaw.autoApprove") : null].filter(Boolean).join(" · ")}
                </div>
              </div>
              {a.isActive === false ? <StatusBadge status="deactivated">{t("bylaw.off")}</StatusBadge> : null}
              <Button size="sm" variant="ghost" onClick={() => { setModalError(""); setActionDraft({ ...a }); }}>{t("bylaw.edit")}</Button>
            </li>
          ))}
        </ul>
      </Card>

      <Card title={t("bylaw.rulesTitle")} actions={<Button size="sm" variant="ghost" onClick={() => { setModalError(""); setRuleDraft({ id: null, name: "", templateKey: null, source: "no_late_month", amountType: "amount", value: 0, isActive: true }); }}>{t("bylaw.addRule")}</Button>}>
        <HintText small>{t("bylaw.rulesHint")}</HintText>
        {b.incentiveRules.length === 0 ? <HintText small>{t("bylaw.noRules")}</HintText> : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {b.incentiveRules.map((r) => (
              <li key={r.id} style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", alignItems: "center", padding: "var(--space-2) 0", borderBottom: "1px solid var(--border-light)" }}>
                <div style={{ flex: "1 1 14rem" }}>
                  <strong>{r.name ?? (r.templateKey ? t(`incentiveTemplates.${r.templateKey}`) : "")}</strong>
                  <div style={{ color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>{t(`ruleSources.${r.source}`)} · {incentiveValueText(t, r.amountType, r.value, i18n.language)}</div>
                </div>
                {!r.isActive ? <StatusBadge status="deactivated">{t("bylaw.off")}</StatusBadge> : null}
                <Button size="sm" variant="ghost" onClick={() => { setModalError(""); setRuleDraft({ ...r, name: r.name ?? (r.templateKey ? t(`incentiveTemplates.${r.templateKey}`) : "") }); }}>{t("bylaw.edit")}</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t("bylaw.publishTitle")}>
        <HintText>{t("bylaw.publishHint")}</HintText>
        {!ready ? <HintText small>{t("bylaw.notReady")}</HintText> : null}
        <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ width: "12rem" }}><Input label={t("bylaw.effectiveFrom")} name="effectiveFrom" type="date" value={effective} onChange={(e) => setEffective(e.target.value)} /></div>
          <div style={{ marginBottom: "var(--space-4)" }}><Toggle checked={reset} onChange={setReset} label={t("bylaw.resetCounters")} /></div>
          <Button style={{ marginBottom: "var(--space-4)" }} loading={busy === "publish"} disabled={!ready} onClick={() => void publish()}>{t("bylaw.publish")}</Button>
        </div>
        {b.versions.length > 0 ? (
          <ul style={{ margin: 0, paddingInlineStart: "var(--space-4)", fontSize: "var(--font-sm)" }}>
            {b.versions.map((v) => (
              <li key={v.id}>{t("bylaw.versionRow", { version: v.version, date: formatDateOnly(v.effectiveFrom, i18n.language), by: v.publishedBy ?? "" })}{v.resetCounters ? ` · ${t("bylaw.countersReset")}` : ""}</li>
            ))}
          </ul>
        ) : null}
      </Card>

      <Modal isOpen={Boolean(typeDraft)} onClose={() => setTypeDraft(null)} title={typeDraft?.id ? t("bylaw.editViolation") : t("bylaw.addViolation")} size="md"
        footer={<Button fullWidth loading={busy === "type"} onClick={() => void saveType()}>{t("bylaw.saveDraft")}</Button>}>
        {typeDraft ? (
          <div style={{ display: "grid", gap: "var(--space-2)" }}>
            <ErrorText>{modalError}</ErrorText>
            <Input label={t("bylaw.violationName")} name="vName" value={typeDraft.name ?? ""} onChange={(e) => setTypeDraft({ ...typeDraft, name: e.target.value })} />
            <Select label={t("bylaw.source")} name="vSource" value={typeDraft.source} onChange={(e) => setTypeDraft({ ...typeDraft, source: e.target.value as ViolationSource })}
              options={SOURCES.map((s) => ({ value: s, label: t(`sources.${s}`) }))} />
            {typeDraft.source === "attendance_late" || typeDraft.source === "attendance_early_leave" ? (
              <Input label={t("bylaw.threshold")} name="vThreshold" type="number" value={typeDraft.thresholdMinutes?.toString() ?? ""}
                onChange={(e) => setTypeDraft({ ...typeDraft, thresholdMinutes: e.target.value === "" ? null : Number(e.target.value) })} />
            ) : null}
            <Input label={t("bylaw.lookback")} name="vLookback" type="number" value={typeDraft.lookbackDays.toString()} onChange={(e) => setTypeDraft({ ...typeDraft, lookbackDays: Number(e.target.value) })} />
            <HintText small>{t("bylaw.lookbackHint")}</HintText>
            <strong>{t("bylaw.ladder")}</strong>
            {typeDraft.steps.map((s, i) => {
              const a = actionById(s.actionTypeId);
              const needsValue = a && (a.kind === "deduction" || a.kind === "suspension");
              return (
                <div key={i} style={{ display: "flex", gap: "var(--space-2)", alignItems: "flex-end", flexWrap: "wrap" }}>
                  <span style={{ minWidth: "5rem", marginBottom: "var(--space-4)" }}>{i === typeDraft.steps.length - 1 ? t("bylaw.stepLast", { n: i + 1 }) : t("bylaw.stepLine", { n: i + 1 })}</span>
                  <div style={{ flex: "1 1 10rem" }}>
                    <Select label={t("bylaw.penalty")} name={`step${i}`} value={s.actionTypeId} onChange={(e) => setStep(i, { actionTypeId: e.target.value })}
                      options={activeActions.map((x) => ({ value: x.id, label: actionTypeName(t, x) }))} />
                  </div>
                  {needsValue ? (
                    <div style={{ width: "7rem" }}>
                      <Input label={t(`unitLabel.${a!.unit ?? "days"}`)} name={`stepValue${i}`} type="number" value={s.value?.toString() ?? ""}
                        onChange={(e) => setStep(i, { value: e.target.value === "" ? null : Number(e.target.value) })} />
                    </div>
                  ) : null}
                  {typeDraft.steps.length > 1 ? (
                    <Button size="sm" variant="ghost" aria-label={t("bylaw.removeStep")} style={{ marginBottom: "var(--space-4)" }}
                      onClick={() => setTypeDraft({ ...typeDraft, steps: typeDraft.steps.filter((_, j) => j !== i) })}><Trash2 size={14} /></Button>
                  ) : null}
                </div>
              );
            })}
            <Button size="sm" variant="ghost" onClick={() => setTypeDraft({ ...typeDraft, steps: [...typeDraft.steps, { occurrence: typeDraft.steps.length + 1, actionTypeId: activeActions[0]?.id ?? "", value: null }] })}>
              <Plus size={14} /> {t("bylaw.addStep")}
            </Button>
            <Toggle checked={typeDraft.isActive} onChange={(on) => setTypeDraft({ ...typeDraft, isActive: on })} label={t("bylaw.inUse")} />
          </div>
        ) : null}
      </Modal>

      <Modal isOpen={Boolean(actionDraft)} onClose={() => setActionDraft(null)} title={actionDraft?.isNew ? t("bylaw.addType") : actionTypeName(t, actionDraft)} size="md"
        footer={<Button fullWidth loading={busy === "action"} onClick={() => void saveAction()}>{t("bylaw.saveDraft")}</Button>}>
        {actionDraft ? (
          <div style={{ display: "grid", gap: "var(--space-2)" }}>
            <ErrorText>{modalError}</ErrorText>
            <Input label={actionDraft.isBuiltin ? t("bylaw.typeNameOptional") : t("bylaw.typeName")} name="aName" value={actionDraft.name ?? ""} onChange={(e) => setActionDraft({ ...actionDraft, name: e.target.value })} />
            {actionDraft.isNew ? (
              <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 10rem" }}>
                  <Select label={t("bylaw.kind")} name="aKind" value={actionDraft.kind} onChange={(e) => setActionDraft({ ...actionDraft, kind: e.target.value as ActionDraft["kind"], unit: e.target.value === "deduction" ? "days" : null })}
                    options={(["warning", "deduction", "suspension", "investigation", "other"] as const).map((k) => ({ value: k, label: t(`kinds.${k}`) }))} />
                </div>
                {actionDraft.kind === "deduction" ? (
                  <div style={{ flex: "1 1 8rem" }}>
                    <Select label={t("bylaw.unit")} name="aUnit" value={actionDraft.unit ?? "days"} onChange={(e) => setActionDraft({ ...actionDraft, unit: e.target.value as "days" })}
                      options={(["days", "hours", "amount"] as const).map((u) => ({ value: u, label: t(`unitLabel.${u}`) }))} />
                  </div>
                ) : null}
              </div>
            ) : null}
            <Toggle checked={actionDraft.requiresInvestigation} onChange={(on) => setActionDraft({ ...actionDraft, requiresInvestigation: on, autoApprove: on ? false : actionDraft.autoApprove })} label={t("bylaw.requiresInvestigation")} />
            <Toggle checked={actionDraft.requiresResponse} onChange={(on) => setActionDraft({ ...actionDraft, requiresResponse: on, responseDays: on ? actionDraft.responseDays ?? 3 : null, autoApprove: on ? false : actionDraft.autoApprove })} label={t("bylaw.requiresResponse")} />
            {actionDraft.requiresResponse ? <Input label={t("bylaw.responseDays")} name="aDays" type="number" value={actionDraft.responseDays?.toString() ?? ""} onChange={(e) => setActionDraft({ ...actionDraft, responseDays: e.target.value === "" ? null : Number(e.target.value) })} /> : null}
            <strong>{t("bylaw.approvalLevels")}</strong>
            {levelPicker(actionDraft.levels, (next) => setActionDraft({ ...actionDraft, levels: next }))}
            <Toggle checked={actionDraft.reporterCannotApprove} onChange={(on) => setActionDraft({ ...actionDraft, reporterCannotApprove: on })} label={t("bylaw.reporterCannotApprove")} />
            {actionDraft.kind === "warning" && !actionDraft.requiresInvestigation && !actionDraft.requiresResponse ? (
              <Toggle checked={actionDraft.autoApprove} onChange={(on) => setActionDraft({ ...actionDraft, autoApprove: on })} label={t("bylaw.autoApproveLabel")} />
            ) : null}
            <Toggle checked={actionDraft.isActive !== false} onChange={(on) => setActionDraft({ ...actionDraft, isActive: on })} label={t("bylaw.inUse")} />
          </div>
        ) : null}
      </Modal>

      <Modal isOpen={Boolean(ruleDraft)} onClose={() => setRuleDraft(null)} title={ruleDraft?.id ? t("bylaw.editRule") : t("bylaw.addRule")} size="sm"
        footer={<Button fullWidth loading={busy === "rule"} onClick={() => void saveRule()}>{t("bylaw.save")}</Button>}>
        {ruleDraft ? (
          <div style={{ display: "grid", gap: "var(--space-2)" }}>
            <ErrorText>{modalError}</ErrorText>
            <Input label={t("bylaw.ruleName")} name="rName" value={ruleDraft.name ?? ""} onChange={(e) => setRuleDraft({ ...ruleDraft, name: e.target.value })} />
            {!ruleDraft.id ? (
              <Select label={t("bylaw.ruleWhen")} name="rSource" value={ruleDraft.source} onChange={(e) => setRuleDraft({ ...ruleDraft, source: e.target.value as RuleDraft["source"] })}
                options={(["no_late_month", "full_attendance_month"] as const).map((s) => ({ value: s, label: t(`ruleSources.${s}`) }))} />
            ) : null}
            <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 9rem" }}>
                <Select label={t("incentive.kind")} name="rType" value={ruleDraft.amountType} onChange={(e) => setRuleDraft({ ...ruleDraft, amountType: e.target.value as AmountType })}
                  options={(["amount", "days", "percent"] as const).map((k) => ({ value: k, label: t(`incentive.kinds.${k}`) }))} />
              </div>
              <div style={{ flex: "1 1 7rem" }}>
                <Input label={t("incentive.value")} name="rValue" type="number" value={ruleDraft.value ? ruleDraft.value.toString() : ""} onChange={(e) => setRuleDraft({ ...ruleDraft, value: Number(e.target.value) })} />
              </div>
            </div>
            <Toggle checked={ruleDraft.isActive} onChange={(on) => setRuleDraft({ ...ruleDraft, isActive: on })} label={t("bylaw.inUse")} />
          </div>
        ) : null}
      </Modal>
    </PageShell>
  );
}
