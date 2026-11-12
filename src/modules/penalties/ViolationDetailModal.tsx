import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import Modal from "../../components/common/Modal";
import Button from "../../components/common/Button";
import Textarea from "../../components/common/Textarea";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import StatusBadge from "../../components/common/StatusBadge";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import LoadingState from "../../components/common/LoadingState";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import { formatDateOnly, formatDateTime } from "../../core/utils/formatDate";
import EmployeeProfileRepository from "../../core/repositories/EmployeeProfileRepository";
import PenaltiesRepository, { type Violation, type ViolationAction } from "../../core/repositories/PenaltiesRepository";
import { actionText, actionTypeName, money, STATUS_BADGE, violationName } from "./penaltyUi";

// HR suite feature 1: one violation - what happened, the rule it was recorded under, every step so far,
// and only the buttons the reader may use now (the server decides them).
export default function ViolationDetailModal({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const { t, i18n } = useTranslation("penalties");
  const [v, setV] = useState<Violation | null>(null);
  const [note, setNote] = useState("");
  const [witness, setWitness] = useState("");
  const [reduceTo, setReduceTo] = useState("");
  const [reduceValue, setReduceValue] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!id) return;
    const r = await PenaltiesRepository.get(id);
    if (r.error) setError(humanizeBackendError(r.error, t) ?? t("loadError"));
    setV(r.data);
  }, [id, t]);

  useEffect(() => {
    setV(null);
    setNote("");
    setWitness("");
    setReduceTo("");
    setReduceValue("");
    setError("");
    void load();
  }, [load]);

  const act = async (action: ViolationAction, data: Record<string, unknown> = {}) => {
    if (!v) return;
    setBusy(action);
    setError("");
    const r = await PenaltiesRepository.act(v.id, action, { note: note.trim() || null, ...data });
    setBusy("");
    if (r.error) return setError(humanizeBackendError(r.error, t) ?? t("actionError"));
    setNote("");
    onChanged();
    await load();
  };

  const view = async (path: string | null) => {
    if (!path) return;
    const url = await EmployeeProfileRepository.fileUrl(path);
    if (url) window.open(url, "_blank", "noopener");
  };

  const has = (a: ViolationAction) => Boolean(v?.actions.includes(a));
  const reduceOptions = (v?.reduceOptions ?? []).filter((o) => o.kind !== "investigation");
  const chosen = reduceOptions.find((o) => o.id === reduceTo);
  const isDeduction = v?.finalAction.kind === "deduction";
  const needsNote = has("investigate") || has("respond") || has("reject") || has("reduce") || has("appeal") || has("cancel") || has("appeal_cancel");

  return (
    <Modal isOpen={Boolean(id)} onClose={onClose} title={v ? `${violationName(t, v)} · ${v.name}` : t("detailTitle")} size="md">
      {!v ? (error ? <ErrorText>{error}</ErrorText> : <LoadingState />) : (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", alignItems: "center" }}>
            <StatusBadge status={STATUS_BADGE[v.status]}>{t(`status.${v.status}`)}</StatusBadge>
            <span>{formatDateOnly(v.occurredOn, i18n.language)}</span>
            <span>· {t("occurrence", { count: v.occurrence })}</span>
            <span>· {t(`sources.${v.source}`)}</span>
          </div>
          <dl style={{ display: "grid", gridTemplateColumns: "minmax(7rem, max-content) 1fr", gap: "6px var(--space-3)", margin: 0 }}>
            <dt>{t("suggested")}</dt><dd style={{ margin: 0 }}>{actionText(t, v.suggested, i18n.language)}</dd>
            {JSON.stringify(v.finalAction) !== JSON.stringify(v.suggested) ? (<><dt>{t("final")}</dt><dd style={{ margin: 0 }}>{actionText(t, v.finalAction, i18n.language)}</dd></>) : null}
            {isDeduction ? (
              <><dt>{t("amount")}</dt><dd style={{ margin: 0 }}>{v.amount != null ? money(v.amount, i18n.language) : t("actionOnly")}</dd></>
            ) : null}
            {v.posted > 0 ? (<><dt>{t("posted")}</dt><dd style={{ margin: 0 }}>{money(v.posted, i18n.language)}{v.amount != null && v.posted < v.amount ? ` · ${t("carried")}` : ""}</dd></>) : null}
            {v.settlement ? (<><dt>{t("settlement")}</dt><dd style={{ margin: 0 }}>{money(v.settlement, i18n.language)}</dd></>) : null}
            {v.reportedBy ? (<><dt>{t("reportedBy")}</dt><dd style={{ margin: 0 }}>{v.reportedBy}</dd></>) : null}
            {v.status === "pending_approval" || v.status === "pending_response" || v.status === "pending_investigation" ? (
              <><dt>{t("waitingFor")}</dt><dd style={{ margin: 0 }}>{v.status === "pending_approval" ? t(`levels.${v.levels[v.currentLevel]}`) : t(`waiting.${v.status}`)}</dd></>
            ) : null}
            {v.appealUntil && (v.status === "approved" || v.status === "reduced") ? (<><dt>{t("appealUntil")}</dt><dd style={{ margin: 0 }}>{formatDateTime(v.appealUntil, i18n.language)}</dd></>) : null}
          </dl>
          <HintText small>{t("versionLine", { version: v.version, date: formatDateOnly(v.versionFrom, i18n.language) })}</HintText>
          {v.note ? <p style={{ margin: 0 }}><strong>{t("whatHappened")}: </strong>{v.note}</p> : null}
          {v.evidencePath ? <Button size="sm" variant="ghost" onClick={() => void view(v.evidencePath)}>{t("viewPhoto")}</Button> : null}
          {v.employeeResponse ? <p style={{ margin: 0 }}><strong>{t("employeeReply")}: </strong>{v.employeeResponse}</p> : null}
          {v.appealText ? <p style={{ margin: 0 }}><strong>{t("appealText")}: </strong>{v.appealText}</p> : null}
          {v.acknowledgedAt ? <HintText small>{t("acknowledgedAt", { date: formatDateTime(v.acknowledgedAt, i18n.language) })}</HintText> : null}
          {v.refusedAckAt ? <HintText small>{t("refusedAckAt", { date: formatDateTime(v.refusedAckAt, i18n.language), witness: v.refusedAckWitness ?? "" })}</HintText> : null}

          {v.steps && v.steps.length > 0 ? (
            <details>
              <summary style={{ cursor: "pointer" }}>{t("timeline")}</summary>
              <ol style={{ margin: "var(--space-2) 0 0", paddingInlineStart: "var(--space-4)", display: "grid", gap: 6, fontSize: "var(--font-sm)" }}>
                {v.steps.map((s, i) => (
                  <li key={i}>
                    <strong>{t(`steps.${s.type}`, { defaultValue: s.type })}</strong>
                    {s.level ? ` (${t(`levels.${v.levels[s.level - 1]}`)})` : ""} · {formatDateTime(s.at, i18n.language)}{s.by ? ` · ${s.by}` : ""}
                    {s.note ? <div style={{ color: "var(--text-secondary)" }}>{s.note}</div> : null}
                    {s.attachment ? <button type="button" onClick={() => void view(s.attachment)} style={{ border: 0, padding: 0, background: "none", color: "var(--text-link)", cursor: "pointer", font: "inherit" }}>{t("viewPhoto")}</button> : null}
                  </li>
                ))}
              </ol>
            </details>
          ) : null}

          <ErrorText>{error}</ErrorText>
          {v.actions.length > 0 ? (
            <div style={{ display: "grid", gap: "var(--space-2)", borderTop: "1px solid var(--border-light)", paddingTop: "var(--space-3)" }}>
              {has("acknowledge") ? <HintText small>{t("acknowledgeHint")}</HintText> : null}
              {needsNote ? (
                <Textarea label={has("investigate") ? t("investigationReport") : has("respond") ? t("yourReply") : has("appeal") ? t("appealReason") : t("noteReason")}
                  name="violationNote" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
              ) : null}
              {has("reduce") ? (
                <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", alignItems: "flex-end" }}>
                  <div style={{ flex: "1 1 12rem" }}>
                    <Select label={t("reduceTo")} name="reduceTo" value={reduceTo} onChange={(e) => setReduceTo(e.target.value)}
                      options={[{ value: "", label: t("choose") }, ...reduceOptions.map((o) => ({ value: o.id, label: actionTypeName(t, o) }))]} />
                  </div>
                  {chosen && (chosen.kind === "deduction" || chosen.kind === "suspension") ? (
                    <div style={{ width: "8rem" }}>
                      <Input label={t(`unitLabel.${chosen.unit ?? "days"}`)} name="reduceValue" type="number" value={reduceValue} onChange={(e) => setReduceValue(e.target.value)} />
                    </div>
                  ) : null}
                </div>
              ) : null}
              {has("refused_ack") ? <Input label={t("witness")} name="witness" value={witness} onChange={(e) => setWitness(e.target.value)} /> : null}
              <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
                {has("investigate") ? <Button loading={busy === "investigate"} onClick={() => void act("investigate")}>{t("do.investigate")}</Button> : null}
                {has("respond") ? <Button loading={busy === "respond"} onClick={() => void act("respond")}>{t("do.respond")}</Button> : null}
                {has("approve") ? <Button loading={busy === "approve"} onClick={() => void act("approve")}>{v.currentLevel + 1 < v.levels.length ? t("do.approveNext") : t("do.approve")}</Button> : null}
                {has("reduce") ? <Button variant="ghost" loading={busy === "reduce"} disabled={!reduceTo} onClick={() => void act("reduce", { actionTypeId: reduceTo, value: reduceValue || null })}>{t("do.reduce")}</Button> : null}
                {has("reject") ? <Button variant="danger" loading={busy === "reject"} onClick={() => void act("reject")}>{t("do.reject")}</Button> : null}
                {has("acknowledge") ? <Button loading={busy === "acknowledge"} onClick={() => void act("acknowledge")}>{t("do.acknowledge")}</Button> : null}
                {has("appeal") ? <Button variant="ghost" loading={busy === "appeal"} onClick={() => void act("appeal")}>{t("do.appeal")}</Button> : null}
                {has("refused_ack") ? <Button variant="ghost" loading={busy === "refused_ack"} disabled={!witness.trim()} onClick={() => void act("refused_ack", { witness })}>{t("do.refused_ack")}</Button> : null}
                {has("appeal_confirm") ? <Button loading={busy === "appeal_confirm"} onClick={() => void act("appeal_confirm")}>{t("do.appeal_confirm")}</Button> : null}
                {has("appeal_cancel") ? <Button variant="danger" loading={busy === "appeal_cancel"} onClick={() => void act("appeal_cancel")}>{t("do.appeal_cancel")}</Button> : null}
                {has("cancel") ? <Button variant="danger" loading={busy === "cancel"} onClick={() => void act("cancel")}>{t("do.cancel")}</Button> : null}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
