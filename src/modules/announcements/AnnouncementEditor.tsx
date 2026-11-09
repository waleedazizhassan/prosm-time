import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "../../core/context/AuthContext";
import AnnouncementRepository, { ACCEPTED_FILES, MAX_FILE_BYTES, type AnnouncementAttachment, type AnnouncementInput, type AudienceType } from "../../core/repositories/AnnouncementRepository";
import SiteRepository from "../../core/repositories/SiteRepository";
import EmployeeRepository from "../../core/repositories/EmployeeRepository";
import Modal from "../../components/common/Modal";
import Button from "../../components/common/Button";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Textarea from "../../components/common/Textarea";
import Toggle from "../../components/common/Toggle";
import DateTimeInput from "../../components/common/DateTimeInput";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import LoadingState from "../../components/common/LoadingState";
import { AttachmentList, useOpenAttachment } from "./AttachmentList";
import { announcementError, toIso, toLocal } from "./announcementsUi";

type Option = { id: string; name: string };

const EMPTY: AnnouncementInput = { kind: "announcement", title: "", body: "", audienceType: "sites", audienceIds: [], requiresAck: false, sendEmail: false, expiresAt: null };

// 2026-11-09 Media Center: write, address, attach, schedule and publish one announcement. The
// server decides what the writer may address; files are kept privately and open for recipients only.
export default function AnnouncementEditor({ id, onClose, onDone }: { id: string | null; onClose: () => void; onDone: (message: string) => void }) {
  const { t } = useTranslation("announcements");
  const { hasPermission } = useAuth();
  const orgWide = hasPermission("announcements.manage");
  const [annId, setAnnId] = useState<string | null>(id);
  const [input, setInput] = useState<AnnouncementInput>(orgWide ? { ...EMPTY, audienceType: "all" } : EMPTY);
  const [publishAt, setPublishAt] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [attachments, setAttachments] = useState<AnnouncementAttachment[]>([]);
  const [loading, setLoading] = useState(Boolean(id));
  const [options, setOptions] = useState<{ sites: Option[]; departments: Option[]; people: Option[] }>({ sites: [], departments: [], people: [] });
  const [search, setSearch] = useState("");
  const [link, setLink] = useState({ url: "", title: "" });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const openAttachment = useOpenAttachment(setError);

  useEffect(() => {
    void (async () => {
      const [sites, departments, people] = await Promise.all([SiteRepository.listSites(), AnnouncementRepository.departments(), EmployeeRepository.listOrganizationMembers()]);
      setOptions({
        sites: (sites.data ?? []).map((s) => ({ id: s.id, name: s.name })),
        departments: (departments.data ?? []).filter((d) => d.isActive).map((d) => ({ id: d.id, name: d.name })),
        people: (people.data ?? []).filter((p) => p.isActive).map((p) => ({ id: p.id, name: p.fullName })),
      });
    })();
  }, []);

  useEffect(() => {
    if (!id) return;
    void (async () => {
      const result = await AnnouncementRepository.get(id);
      setLoading(false);
      if (result.error || !result.data) {
        setError(announcementError(result.error, t));
        return;
      }
      const d = result.data;
      setInput({ kind: d.kind, title: d.title, body: d.body, audienceType: d.audienceType, audienceIds: d.audienceIds, requiresAck: d.requiresAck, sendEmail: d.sendEmail, expiresAt: d.expiresAt });
      setPublishAt(toLocal(d.publishAt));
      setExpiresAt(toLocal(d.expiresAt));
      setAttachments(d.attachments);
    })();
  }, [id, t]);

  const set = <K extends keyof AnnouncementInput>(key: K, value: AnnouncementInput[K]) => setInput((current) => ({ ...current, [key]: value }));

  const shown = useMemo(() => {
    const list = input.audienceType === "all" ? [] : options[input.audienceType];
    const q = search.trim().toLowerCase();
    return q ? list.filter((o) => o.name.toLowerCase().includes(q)) : list;
  }, [input.audienceType, options, search]);

  const toggle = (optionId: string) =>
    set("audienceIds", input.audienceIds.includes(optionId) ? input.audienceIds.filter((x) => x !== optionId) : [...input.audienceIds, optionId]);

  // saves the draft (creating it the first time) and returns its id
  const save = async (sendEmail = input.sendEmail): Promise<string | null> => {
    setError("");
    const result = await AnnouncementRepository.save(annId, { ...input, sendEmail, expiresAt: toIso(expiresAt) });
    if (result.error || !result.data) {
      setError(announcementError(result.error, t));
      return null;
    }
    setAnnId(result.data.id);
    return result.data.id;
  };

  const reloadAttachments = async (savedId: string) => {
    const result = await AnnouncementRepository.get(savedId);
    if (result.data) setAttachments(result.data.attachments);
  };

  const saveDraft = async () => {
    setBusy("save");
    const saved = await save();
    setBusy("");
    if (saved) onDone(t("editor.saved"));
  };

  const publish = async (withEmail: boolean) => {
    setBusy(withEmail ? "email" : "publish");
    const saved = await save(withEmail);
    if (!saved) {
      setBusy("");
      return;
    }
    const result = await AnnouncementRepository.publish(saved, toIso(publishAt));
    setBusy("");
    if (result.error || !result.data) {
      setError(announcementError(result.error, t));
      return;
    }
    onDone(result.data.status === "scheduled" ? t("editor.scheduled") : t("editor.published", { count: result.data.recipients ?? 0 }));
  };

  const addLink = async () => {
    setBusy("link");
    const saved = annId ?? (await save());
    if (saved) {
      const result = await AnnouncementRepository.addLink(saved, link.url.trim(), link.title.trim());
      if (result.error) setError(announcementError(result.error, t));
      else {
        setLink({ url: "", title: "" });
        await reloadAttachments(saved);
      }
    }
    setBusy("");
  };

  const addFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setError(t("errors.fileTooLarge"));
      return;
    }
    setBusy("file");
    const saved = annId ?? (await save());
    if (saved) {
      const result = await AnnouncementRepository.uploadFile(saved, file);
      if (result.error) setError(announcementError(result.error, t));
      else await reloadAttachments(saved);
    }
    setBusy("");
    if (fileInput.current) fileInput.current.value = "";
  };

  const removeAttachment = async (item: AnnouncementAttachment) => {
    setBusy(`remove-${item.id}`);
    const result = await AnnouncementRepository.removeAttachment(item.id);
    setBusy("");
    if (result.error) setError(announcementError(result.error, t));
    else setAttachments((current) => current.filter((a) => a.id !== item.id));
  };

  const removeDraft = async () => {
    if (!annId) return;
    setBusy("delete");
    const result = await AnnouncementRepository.remove(annId, attachments);
    setBusy("");
    if (result.error) setError(announcementError(result.error, t));
    else onDone(t("editor.deleted"));
  };

  const audienceOptions: { value: AudienceType; label: string }[] = [
    ...(orgWide ? [{ value: "all" as const, label: t("audience.all") }] : []),
    { value: "sites", label: t("audience.sites") },
    ...(orgWide ? [{ value: "departments" as const, label: t("audience.departments") }] : []),
    { value: "people", label: t("audience.people") },
  ];
  const scheduled = Boolean(publishAt);
  const ready = input.title.trim().length > 0 && (input.audienceType === "all" || input.audienceIds.length > 0);

  return (
    <Modal isOpen onClose={onClose} title={id ? t("editor.editTitle") : t("editor.newTitle")} size="lg"
      footer={
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", justifyContent: "flex-end", width: "100%" }}>
          {annId ? <Button variant="danger" size="sm" loading={busy === "delete"} onClick={removeDraft}>{t("editor.delete")}</Button> : null}
          <Button variant="ghost" loading={busy === "save"} disabled={!input.title.trim()} onClick={saveDraft}>{t("editor.saveDraft")}</Button>
          <Button variant="ghost" loading={busy === "publish"} disabled={!ready} onClick={() => void publish(false)}>{scheduled ? t("editor.scheduleOnly") : t("editor.publishOnly")}</Button>
          <Button loading={busy === "email"} disabled={!ready} onClick={() => void publish(true)}>{scheduled ? t("editor.scheduleWithEmail") : t("editor.publishWithEmail")}</Button>
        </div>
      }>
      {loading ? <LoadingState /> : (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          <Select label={t("editor.kind")} name="annKind" value={input.kind} onChange={(event) => set("kind", event.target.value as AnnouncementInput["kind"])}
            options={[{ value: "announcement", label: t("kinds.announcement") }, { value: "statement", label: t("kinds.statement") }]} />
          <Input label={t("editor.title")} name="annTitle" value={input.title} onChange={(event) => set("title", event.target.value.slice(0, 200))} />
          <Textarea label={t("editor.body")} name="annBody" rows={8} value={input.body} onChange={(event) => set("body", event.target.value.slice(0, 20000))} />

          <div>
            <Select label={t("editor.audience")} name="annAudience" value={input.audienceType}
              onChange={(event) => setInput((current) => ({ ...current, audienceType: event.target.value as AudienceType, audienceIds: [] }))} options={audienceOptions} />
            {!orgWide ? <HintText small>{t("editor.audienceLimited")}</HintText> : null}
            {input.audienceType !== "all" ? (
              <div style={{ marginTop: "var(--space-2)" }}>
                <Input label={t("editor.search")} name="annSearch" value={search} onChange={(event) => setSearch(event.target.value)} />
                <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--border-light)", borderRadius: 8, padding: "var(--space-2)", marginTop: "var(--space-1)" }}>
                  {shown.length === 0 ? <HintText small>{input.audienceType === "departments" ? t("editor.noDepartments") : t("editor.nothing")}</HintText> : null}
                  {shown.map((o) => (
                    <label key={o.id} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", padding: "4px 0", cursor: "pointer" }}>
                      <input type="checkbox" checked={input.audienceIds.includes(o.id)} onChange={() => toggle(o.id)} />
                      <span>{o.name}</span>
                    </label>
                  ))}
                </div>
                <HintText small>{t("editor.chosen", { count: input.audienceIds.length })}</HintText>
              </div>
            ) : null}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
            <Toggle checked={input.requiresAck} onChange={(value) => set("requiresAck", value)} label={t("editor.requiresAck")} />
            <span>{t("editor.requiresAck")}</span>
          </div>

          <DateTimeInput label={t("editor.publishAt")} name="annPublishAt" value={publishAt} onChange={setPublishAt} helperText={t("editor.publishAtHint")} />
          <DateTimeInput label={t("editor.expiresAt")} name="annExpiresAt" value={expiresAt} onChange={setExpiresAt} helperText={t("editor.expiresAtHint")} />

          <div>
            <strong>{t("attachments.title")}</strong>
            <HintText small>{t("attachments.hint")}</HintText>
            <AttachmentList items={attachments} onOpen={(item) => void openAttachment(item)} />
            {attachments.length > 0 ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-1)", marginTop: "var(--space-1)" }}>
                {attachments.map((item) => (
                  <Button key={item.id} size="xs" variant="ghost" loading={busy === `remove-${item.id}`} onClick={() => void removeAttachment(item)}>{t("attachments.remove", { name: item.title })}</Button>
                ))}
              </div>
            ) : null}
            <div style={{ display: "grid", gap: "var(--space-2)", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr) auto", alignItems: "end", marginTop: "var(--space-2)" }}>
              <Input label={t("attachments.url")} name="annLinkUrl" value={link.url} onChange={(event) => setLink({ ...link, url: event.target.value })} />
              <Input label={t("attachments.linkTitle")} name="annLinkTitle" value={link.title} onChange={(event) => setLink({ ...link, title: event.target.value })} />
              <Button size="sm" loading={busy === "link"} disabled={!link.url.trim() || !input.title.trim()} onClick={addLink}>{t("attachments.addLink")}</Button>
            </div>
            <div style={{ marginTop: "var(--space-2)" }}>
              <input ref={fileInput} type="file" accept={ACCEPTED_FILES} style={{ display: "none" }} onChange={(event) => void addFile(event.target.files?.[0])} />
              <Button size="sm" variant="ghost" loading={busy === "file"} disabled={!input.title.trim()} onClick={() => fileInput.current?.click()}>{t("attachments.addFile")}</Button>
              <HintText small>{t("attachments.fileHint")}</HintText>
            </div>
          </div>
          <ErrorText>{error}</ErrorText>
        </div>
      )}
    </Modal>
  );
}
