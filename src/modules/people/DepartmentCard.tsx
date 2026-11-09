import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import AnnouncementRepository, { type Department } from "../../core/repositories/AnnouncementRepository";
import Card from "../../components/common/Card";
import Select from "../../components/common/Select";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import { announcementError } from "../announcements/announcementsUi";

// 2026-11-09 Media Center: a person's department, changed by whoever may edit them (the server checks
// employees.edit and authority over the person; the change is in the action log).
export default function DepartmentCard({ userId, canEdit }: { userId: string; canEdit: boolean }) {
  const { t } = useTranslation("announcements");
  const [departments, setDepartments] = useState<Department[]>([]);
  const [value, setValue] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void Promise.all([AnnouncementRepository.departments(), AnnouncementRepository.userDepartment(userId)]).then(([list, mine]) => {
      setDepartments(list.data ?? []);
      setValue(mine.data?.departmentId ?? "");
      setLoaded(true);
    });
  }, [userId]);

  const change = async (next: string) => {
    const previous = value;
    setValue(next);
    setSaved(false);
    setError("");
    const result = await AnnouncementRepository.setUserDepartment(userId, next || null);
    if (result.error) {
      setValue(previous);
      setError(announcementError(result.error, t));
    } else setSaved(true);
  };

  if (!loaded) return null;
  const current = departments.find((d) => d.id === value);
  if (!canEdit) {
    return (
      <Card title={t("departments.personTitle")}>
        <HintText>{current?.name ?? t("departments.noDepartment")}</HintText>
      </Card>
    );
  }
  const options = [{ value: "", label: t("departments.noDepartment") }, ...departments.filter((d) => d.isActive || d.id === value).map((d) => ({ value: d.id, label: d.name }))];
  return (
    <Card title={t("departments.personTitle")}>
      <div style={{ maxWidth: 360 }}>
        <Select label={t("departments.choose")} name="personDepartment" value={value} options={options} onChange={(event) => void change(event.target.value)} />
      </div>
      {departments.length === 0 ? <HintText small>{t("editor.noDepartments")}</HintText> : null}
      {saved ? <HintText small>{t("departments.saved")}</HintText> : null}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
