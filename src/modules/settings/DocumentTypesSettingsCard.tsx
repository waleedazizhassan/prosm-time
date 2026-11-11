import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import Card from "../../components/common/Card";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Toggle from "../../components/common/Toggle";
import Button from "../../components/common/Button";
import Modal from "../../components/common/Modal";
import HintText from "../../components/common/HintText";
import ErrorText from "../../components/common/ErrorText";
import SuccessText from "../../components/common/SuccessText";
import StatusBadge from "../../components/common/StatusBadge";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import DocumentsRepository, { type ClockInRule, type DocumentType } from "../../core/repositories/DocumentsRepository";
import EmployeeProfileRepository, { type JobTitle } from "../../core/repositories/EmployeeProfileRepository";
import SiteRepository from "../../core/repositories/SiteRepository";

type Draft = Omit<DocumentType, "id" | "templateKey"> & { id: string | null; reminderText: string };

const EMPTY: Draft = {
  id: null, name: "", isMandatory: true, hasExpiry: true, reminderDays: [30, 7, 0], reminderText: "30, 7, 0",
  appliesTo: "all", jobTitleIds: [], siteIds: [], clockInRule: "none", isActive: true,
};

// HR suite feature 2: the company's own document list - what is required, for whom (everyone, some jobs or
// some sites), whether it expires, when to remind and what happens at clock-in when it has expired.
// PROSM writes no names in by itself: the ready lists add names only, stopped, for the company to review.
export default function DocumentTypesSettingsCard() {
  const { t } = useTranslation("documents");
  const [types, setTypes] = useState<DocumentType[]>([]);
  const [titles, setTitles] = useState<JobTitle[]>([]);
  const [sites, setSites] = useState<{ id: string; name: string }[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = async () => setTypes((await DocumentsRepository.listTypes()).data ?? []);
  useEffect(() => {
    void load();
    void EmployeeProfileRepository.listJobTitles().then((r) => setTitles((r.data ?? []).filter((x) => x.isActive)));
    void SiteRepository.listSites().then((r) => setSites((r.data ?? []).map((s) => ({ id: s.id, name: s.name }))));
  }, []);

  const edit = (type: DocumentType | null) => {
    setError("");
    setDraft(type ? { ...type, reminderText: type.reminderDays.join(", ") } : { ...EMPTY });
  };

  const save = async () => {
    if (!draft) return;
    const days = [...new Set(draft.reminderText.split(/[,\s،]+/).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x >= 0 && x <= 365))].sort((a, b) => b - a);
    setBusy("save");
    setError("");
    const r = await DocumentsRepository.saveType(draft.id, {
      name: draft.name.trim(), is_mandatory: draft.isMandatory, has_expiry: draft.hasExpiry, reminder_days: draft.hasExpiry ? days : [],
      applies_to: draft.appliesTo, job_title_ids: draft.jobTitleIds, site_ids: draft.siteIds, clock_in_rule: draft.hasExpiry ? draft.clockInRule : "none", is_active: draft.isActive,
    });
    setBusy("");
    if (r.error) return setError(humanizeBackendError(r.error, t) ?? t("types.error"));
    setDraft(null);
    setNotice(t("types.saved"));
    await load();
  };

  const addTemplate = async (template: "eg" | "gulf") => {
    setBusy(template);
    setError("");
    const r = await DocumentsRepository.addTemplates(template);
    setBusy("");
    if (r.error) return setError(humanizeBackendError(r.error, t) ?? t("types.error"));
    setNotice(t("types.templateAdded", { count: r.data?.added ?? 0 }));
    await load();
  };

  const toggleId = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const chips = (all: { id: string; name: string }[], picked: string[], onPick: (id: string) => void) => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {all.map((x) => (
        <button key={x.id} type="button" onClick={() => onPick(x.id)} aria-pressed={picked.includes(x.id)}
          style={{ padding: "4px 10px", borderRadius: 999, border: "1px solid var(--border-light)", cursor: "pointer", font: "inherit", fontSize: "var(--font-sm)",
            background: picked.includes(x.id) ? "var(--brand-primary)" : "transparent", color: picked.includes(x.id) ? "#fff" : "inherit" }}>
          {x.name}
        </button>
      ))}
    </div>
  );

  return (
    <Card title={t("types.title")} actions={<Button size="sm" onClick={() => edit(null)}>{t("types.add")}</Button>}>
      <HintText>{t("types.hint")}</HintText>
      <ErrorText>{draft ? "" : error}</ErrorText>
      {notice ? <SuccessText>{notice}</SuccessText> : null}
      {types.length === 0 ? (
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          <HintText small>{t("types.templatesHint")}</HintText>
          <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
            <Button size="sm" variant="ghost" loading={busy === "eg"} onClick={() => void addTemplate("eg")}>{t("types.templateEg")}</Button>
            <Button size="sm" variant="ghost" loading={busy === "gulf"} onClick={() => void addTemplate("gulf")}>{t("types.templateGulf")}</Button>
          </div>
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {types.map((type) => (
            <li key={type.id} style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap", padding: "var(--space-2) 0", borderBottom: "1px solid var(--border-light)" }}>
              <div style={{ flex: "1 1 12rem", minWidth: 0 }}>
                <strong>{type.name}</strong>
                <div style={{ color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>
                  {[type.isMandatory ? t("types.mandatory") : t("types.optional"),
                    type.hasExpiry ? t("types.remindAt", { days: type.reminderDays.join("، ") }) : t("types.noExpiry"),
                    t(`types.appliesTo.${type.appliesTo}`),
                    type.clockInRule !== "none" ? t(`types.clockIn.${type.clockInRule}`) : null].filter(Boolean).join(" · ")}
                </div>
              </div>
              {!type.isActive ? <StatusBadge status="deactivated">{t("types.stopped")}</StatusBadge> : null}
              <Button size="sm" variant="ghost" onClick={() => edit(type)}>{t("types.edit")}</Button>
            </li>
          ))}
        </ul>
      )}

      <Modal isOpen={Boolean(draft)} onClose={() => setDraft(null)} title={draft?.id ? t("types.editTitle") : t("types.addTitle")}
        footer={<Button fullWidth loading={busy === "save"} onClick={() => void save()}>{t("types.save")}</Button>}>
        {draft ? (
          <div style={{ display: "grid", gap: "var(--space-3)" }}>
            <ErrorText>{error}</ErrorText>
            <Input label={t("types.name")} name="docTypeName" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required />
            <Toggle checked={draft.isMandatory} onChange={(v) => setDraft({ ...draft, isMandatory: v })} label={t("types.mandatoryLabel")} />
            <Toggle checked={draft.hasExpiry} onChange={(v) => setDraft({ ...draft, hasExpiry: v })} label={t("types.hasExpiry")} />
            {draft.hasExpiry ? (
              <>
                <Input label={t("types.reminderDays")} name="docTypeReminders" value={draft.reminderText} onChange={(e) => setDraft({ ...draft, reminderText: e.target.value })} />
                <HintText small>{t("types.reminderDaysHint")}</HintText>
                <Select label={t("types.clockInRule")} name="docTypeClockIn" value={draft.clockInRule}
                  onChange={(e) => setDraft({ ...draft, clockInRule: e.target.value as ClockInRule })}
                  options={(["none", "warn", "block"] as const).map((v) => ({ value: v, label: t(`types.clockInOption.${v}`) }))} />
              </>
            ) : null}
            <Select label={t("types.appliesToLabel")} name="docTypeAppliesTo" value={draft.appliesTo}
              onChange={(e) => setDraft({ ...draft, appliesTo: e.target.value as Draft["appliesTo"] })}
              options={(["all", "job_titles", "sites"] as const).map((v) => ({ value: v, label: t(`types.appliesTo.${v}`) }))} />
            {draft.appliesTo === "job_titles" ? (titles.length ? chips(titles, draft.jobTitleIds, (id) => setDraft({ ...draft, jobTitleIds: toggleId(draft.jobTitleIds, id) })) : <HintText small>{t("types.noJobTitles")}</HintText>) : null}
            {draft.appliesTo === "sites" ? chips(sites, draft.siteIds, (id) => setDraft({ ...draft, siteIds: toggleId(draft.siteIds, id) })) : null}
            <Toggle checked={draft.isActive} onChange={(v) => setDraft({ ...draft, isActive: v })} label={t("types.active")} />
          </div>
        ) : null}
      </Modal>
    </Card>
  );
}
