import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import Card from "../../../components/common/Card";
import Input from "../../../components/common/Input";
import Select from "../../../components/common/Select";
import Button from "../../../components/common/Button";
import ErrorText from "../../../components/common/ErrorText";
import SuccessText from "../../../components/common/SuccessText";
import humanizeBackendError from "../../../core/utils/humanizeBackendError";
import { formatDateOnly } from "../../../core/utils/formatDate";
import EmployeeRepository from "../../../core/repositories/EmployeeRepository";
import EmployeeProfileRepository, { type EmployeeProfile, type JobTitle } from "../../../core/repositories/EmployeeProfileRepository";
import styles from "./Profile.module.css";

const FIELDS = ["phone", "emergency_contact_name", "emergency_contact_phone", "national_id", "birth_date", "address"] as const;

// HR suite feature 3: the person's own data - job, status and personal details. Full access edits;
// a manager sees the job and how to reach the person (no national id, birth date or address); the person
// sees their own, read only.
export default function PersonalDataTab({ profile, onSaved }: { profile: EmployeeProfile; onSaved: () => void }) {
  const { t, i18n } = useTranslation("people");
  const p = profile.personal;
  const initial = {
    phone: p.phone ?? "", emergency_contact_name: p.emergencyContactName ?? "", emergency_contact_phone: p.emergencyContactPhone ?? "",
    national_id: p.nationalId ?? "", birth_date: p.birthDate ?? "", address: p.address ?? "",
    job_title_id: profile.header.jobTitleId ?? "", employment_status: profile.header.employmentStatus,
  };
  const [form, setForm] = useState(initial);
  // owner 2026-11-12: the full legal name (payslips, reports, official papers) beside the short account name
  const [legalName, setLegalName] = useState(profile.header.legalName ?? "");
  const [titles, setTitles] = useState<JobTitle[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (profile.canEdit) void EmployeeProfileRepository.listJobTitles().then((r) => setTitles(r.data ?? []));
  }, [profile.canEdit]);

  const save = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    const result = await EmployeeProfileRepository.saveHrData(profile.header.id, { ...form });
    if (!result.error && legalName.trim() !== (profile.header.legalName ?? "")) {
      const legal = await EmployeeRepository.setLegalName(profile.header.id, legalName.trim());
      if (!legal.success) result.error = legal.message;
    }
    setSaving(false);
    if (result.error) {
      setError(humanizeBackendError(result.error, t) ?? t("profile.saveError"));
      return;
    }
    setSaved(true);
    onSaved();
  };

  if (!profile.canEdit) {
    const facts: [string, string | null][] = [
      [t("profile.fields.legalName"), profile.header.legalName],
      [t("profile.fields.jobTitle"), profile.header.jobTitle],
      [t("profile.fields.phone"), p.phone],
      [t("profile.fields.emergency_contact_name"), p.emergencyContactName],
      [t("profile.fields.emergency_contact_phone"), p.emergencyContactPhone],
      ...(profile.access === "self"
        ? ([
            [t("profile.fields.national_id"), p.nationalId],
            [t("profile.fields.birth_date"), p.birthDate ? formatDateOnly(p.birthDate, i18n.language) : null],
            [t("profile.fields.address"), p.address],
          ] as [string, string | null][])
        : []),
    ];
    return (
      <Card title={t("profile.tabs.data")}>
        <dl className={styles.grid}>
          {facts.map(([label, value]) => (
            <div key={label} className={styles.fact}>
              <dt>{label}</dt>
              <dd>{value || "—"}</dd>
            </div>
          ))}
        </dl>
      </Card>
    );
  }

  return (
    <Card title={t("profile.tabs.data")}>
      <div className={styles.grid}>
        <Input label={t("profile.fields.legalName")} name="legalName" value={legalName} onChange={(event) => { setLegalName(event.target.value); setSaved(false); }} disabled={saving} />
        <Select label={t("profile.fields.jobTitle")} name="jobTitle" value={form.job_title_id}
          onChange={(event) => { setForm({ ...form, job_title_id: event.target.value }); setSaved(false); }}
          options={[{ value: "", label: titles.length ? t("profile.noJobTitle") : t("profile.noJobTitlesYet") },
            ...titles.filter((x) => x.isActive || x.id === form.job_title_id).map((x) => ({ value: x.id, label: x.name }))]} />
        <Select label={t("profile.fields.status")} name="employmentStatus" value={form.employment_status}
          onChange={(event) => { setForm({ ...form, employment_status: event.target.value as typeof form.employment_status }); setSaved(false); }}
          options={(["active", "suspended", "ended"] as const).map((s) => ({ value: s, label: t(`profile.status.${s}`) }))} />
        {FIELDS.map((field) => (
          <Input key={field} label={t(`profile.fields.${field}`)} name={field} type={field === "birth_date" ? "date" : field.endsWith("phone") ? "tel" : "text"}
            value={form[field]} onChange={(event) => { setForm({ ...form, [field]: event.target.value }); setSaved(false); }} disabled={saving} />
        ))}
      </div>
      <ErrorText>{error}</ErrorText>
      {saved ? <SuccessText>{t("profile.saved")}</SuccessText> : null}
      <div style={{ marginTop: "var(--space-3)" }}>
        <Button onClick={() => void save()} loading={saving}>{t("profile.save")}</Button>
      </div>
    </Card>
  );
}
