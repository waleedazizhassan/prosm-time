import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import Card from "../../components/common/Card";
import Input from "../../components/common/Input";
import Button from "../../components/common/Button";
import HintText from "../../components/common/HintText";
import ErrorText from "../../components/common/ErrorText";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import EmployeeProfileRepository, { type JobTitle } from "../../core/repositories/EmployeeProfileRepository";

// HR suite feature 3 (2026-11-11): the company's job titles - chosen in each employee's file, and used by
// the documents that apply to a job (a driving licence for drivers only). A title in use is stopped, not deleted.
export default function JobTitlesSettingsCard() {
  const { t } = useTranslation("settings");
  const [titles, setTitles] = useState<JobTitle[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = async () => setTitles((await EmployeeProfileRepository.listJobTitles()).data ?? []);
  useEffect(() => {
    void load();
  }, []);

  const save = async (id: string | null, value: string, active = true) => {
    setBusy(id ?? "new");
    setError("");
    const result = await EmployeeProfileRepository.saveJobTitle(id, value, active);
    setBusy("");
    if (result.error) {
      setError(humanizeBackendError(result.error, t) ?? t("jobTitles.error"));
      return;
    }
    if (!id) setName("");
    await load();
  };

  return (
    <Card title={t("jobTitles.title")}>
      <HintText>{t("jobTitles.hint")}</HintText>
      <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "flex-end", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 14rem" }}>
          <Input label={t("jobTitles.name")} name="jobTitleName" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <Button onClick={() => void save(null, name)} loading={busy === "new"} disabled={!name.trim()} style={{ marginBottom: "var(--space-4)" }}>{t("jobTitles.add")}</Button>
      </div>
      <ErrorText>{error}</ErrorText>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
        {titles.map((title) => (
          <li key={title.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", border: "1px solid var(--border-light)", borderRadius: 999,
            opacity: title.isActive ? 1 : 0.55, fontSize: "var(--font-sm)" }}>
            <span>{title.name}</span>
            <small style={{ color: "var(--text-secondary)" }}>{t("jobTitles.people", { count: title.people })}</small>
            <button type="button" onClick={() => void save(title.id, title.name, !title.isActive)} disabled={busy === title.id}
              style={{ border: 0, background: "none", color: "var(--text-link)", cursor: "pointer", font: "inherit", fontSize: "var(--font-xs)" }}>
              {title.isActive ? t("jobTitles.stop") : t("jobTitles.restore")}
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
