import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import AnnouncementRepository, { type Department } from "../../core/repositories/AnnouncementRepository";
import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import Input from "../../components/common/Input";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import { announcementError } from "../announcements/announcementsUi";

// 2026-11-09 Media Center: the organisation's departments (departments.manage). Archiving keeps the
// people's history; an archived department can no longer be chosen.
export default function DepartmentsSettingsCard() {
  const { t } = useTranslation("announcements");
  const [items, setItems] = useState<Department[]>([]);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const result = await AnnouncementRepository.departments();
    if (result.error) setError(announcementError(result.error, t));
    setItems(result.data ?? []);
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (id: string | null, value: string, isActive = true) => {
    setBusy(id ?? "new");
    setError("");
    const result = await AnnouncementRepository.saveDepartment(id, value.trim(), isActive);
    setBusy("");
    if (result.error) {
      setError(announcementError(result.error, t));
      return;
    }
    if (!id) setName("");
    setRenaming(null);
    await load();
  };

  return (
    <Card title={t("departments.title")}>
      <HintText small>{t("departments.hint")}</HintText>
      <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "flex-end", flexWrap: "wrap", maxWidth: 520 }}>
        <div style={{ flex: "1 1 240px" }}>
          <Input label={t("departments.name")} name="newDepartment" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <Button loading={busy === "new"} disabled={!name.trim()} onClick={() => void save(null, name)}>{t("departments.add")}</Button>
      </div>
      <ErrorText>{error}</ErrorText>
      {items.length === 0 ? <HintText small>{t("departments.none")}</HintText> : null}
      <div style={{ display: "grid", gap: "var(--space-1)", marginTop: "var(--space-2)" }}>
        {items.map((d) => (
          <div key={d.id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--space-2)", padding: "6px 0", borderBottom: "1px solid var(--border-light)", opacity: d.isActive ? 1 : 0.6 }}>
            {renaming?.id === d.id ? (
              <>
                <div style={{ flex: "1 1 200px" }}>
                  <Input label={t("departments.name")} name={`rename-${d.id}`} value={renaming.name} onChange={(event) => setRenaming({ id: d.id, name: event.target.value })} />
                </div>
                <Button size="sm" loading={busy === d.id} disabled={!renaming.name.trim()} onClick={() => void save(d.id, renaming.name, d.isActive)}>{t("departments.save")}</Button>
              </>
            ) : (
              <>
                <span style={{ flex: "1 1 auto" }}>{d.name}{d.isActive ? "" : ` · ${t("departments.archived")}`}</span>
                <span style={{ color: "var(--text-secondary)", fontSize: "var(--font-xs)" }}>{t("departments.members", { count: d.members })}</span>
                <Button size="xs" variant="ghost" onClick={() => setRenaming({ id: d.id, name: d.name })}>{t("departments.rename")}</Button>
                <Button size="xs" variant="ghost" loading={busy === d.id} onClick={() => void save(d.id, d.name, !d.isActive)}>{d.isActive ? t("departments.archive") : t("departments.restore")}</Button>
              </>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
