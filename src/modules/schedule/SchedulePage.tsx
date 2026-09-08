import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "../../core/context/AuthContext";
import ShiftRepository, { type MyShiftRow, type ShiftTemplate, type SiteShiftRow } from "../../core/repositories/ShiftRepository";
import SiteRepository, { type Site } from "../../core/repositories/SiteRepository";
import EmployeeRepository, { type OrgMember } from "../../core/repositories/EmployeeRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import { formatDateOnly } from "../../core/utils/formatDate";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Textarea from "../../components/common/Textarea";
import Button from "../../components/common/Button";
import Table, { type TableColumn } from "../../components/common/Table";
import StatusBadge from "../../components/common/StatusBadge";
import ErrorText from "../../components/common/ErrorText";

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// PROSM Time - § user-directed: real advance shift scheduling/
// rostering, the last of the 3 competitive gaps this session's own
// research found (every competitor researched has drag-and-drop shift
// planning; PROSM Time had none). schedules.manage is an established
// permission that already existed, unused, since Phase 1. "My Shifts"
// is visible to everyone (self-access, same posture as Timesheets/
// Allowances/Leave); the management section only renders for schedules.
// manage holders/the Owner, same pattern as Allowances' own canApprove
// section.
export default function SchedulePage() {
  const { t, i18n } = useTranslation("schedule");
  const { hasPermission, profile } = useAuth();
  const canManage = hasPermission("schedules.manage") || Boolean(profile?.isOwner);

  const today = new Date();
  const [myShifts, setMyShifts] = useState<MyShiftRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [sites, setSites] = useState<Site[]>([]);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [templates, setTemplates] = useState<ShiftTemplate[]>([]);
  const [selectedSiteId, setSelectedSiteId] = useState("");
  const [siteShifts, setSiteShifts] = useState<SiteShiftRow[]>([]);
  const [siteShiftsLoading, setSiteShiftsLoading] = useState(false);
  const [rangeStart, setRangeStart] = useState(isoDate(today));
  const [rangeEnd, setRangeEnd] = useState(isoDate(new Date(today.getTime() + 13 * 24 * 60 * 60 * 1000)));

  const [templateName, setTemplateName] = useState("");
  const [templateStart, setTemplateStart] = useState("08:00");
  const [templateEnd, setTemplateEnd] = useState("16:00");
  const [templateSubmitting, setTemplateSubmitting] = useState(false);
  const [templateError, setTemplateError] = useState("");

  const [assignUserId, setAssignUserId] = useState("");
  const [assignTemplateId, setAssignTemplateId] = useState("");
  const [assignDate, setAssignDate] = useState(isoDate(today));
  const [assignStart, setAssignStart] = useState("08:00");
  const [assignEnd, setAssignEnd] = useState("16:00");
  const [assignNotes, setAssignNotes] = useState("");
  const [assignSubmitting, setAssignSubmitting] = useState(false);
  const [assignError, setAssignError] = useState("");
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const loadMine = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    const result = await ShiftRepository.listMine();
    if (!result.success) setLoadError(humanizeBackendError(result.message, t) ?? t("loadError"));
    else setMyShifts(result.data ?? []);
    setLoading(false);
  }, [t]);

  useEffect(() => {
    loadMine();
  }, [loadMine]);

  useEffect(() => {
    if (!canManage) return;
    SiteRepository.listSites().then((result) => {
      const list = result.success ? result.data ?? [] : [];
      setSites(list);
      setSelectedSiteId((current) => current || list[0]?.id || "");
    });
    EmployeeRepository.listOrganizationMembers().then((result) => {
      setMembers(result.success ? result.data ?? [] : []);
    });
  }, [canManage]);

  const loadSiteData = useCallback(async () => {
    if (!canManage || !selectedSiteId) return;
    setSiteShiftsLoading(true);
    const [templatesResult, shiftsResult] = await Promise.all([
      ShiftRepository.listTemplates(selectedSiteId),
      ShiftRepository.listForSite(selectedSiteId, rangeStart, rangeEnd),
    ]);
    setTemplates(templatesResult.success ? templatesResult.data ?? [] : []);
    setSiteShifts(shiftsResult.success ? shiftsResult.data ?? [] : []);
    setSiteShiftsLoading(false);
  }, [canManage, selectedSiteId, rangeStart, rangeEnd]);

  useEffect(() => {
    loadSiteData();
  }, [loadSiteData]);

  const handleCreateTemplate = async () => {
    if (!selectedSiteId || !templateName.trim()) return;
    setTemplateSubmitting(true);
    setTemplateError("");
    const result = await ShiftRepository.createTemplate(selectedSiteId, templateName, `${templateStart}:00`, `${templateEnd}:00`);
    setTemplateSubmitting(false);
    if (!result.success) {
      setTemplateError(humanizeBackendError(result.message, t) ?? t("templateError"));
      return;
    }
    setTemplateName("");
    await loadSiteData();
  };

  const applyTemplate = (templateId: string) => {
    setAssignTemplateId(templateId);
    const template = templates.find((item) => item.id === templateId);
    if (template) {
      setAssignStart(template.startTime.slice(0, 5));
      setAssignEnd(template.endTime.slice(0, 5));
    }
  };

  const handleAssign = async () => {
    if (!assignUserId || !selectedSiteId || !assignDate) return;
    setAssignSubmitting(true);
    setAssignError("");
    const result = await ShiftRepository.assign(assignUserId, selectedSiteId, assignDate, `${assignStart}:00`, `${assignEnd}:00`, assignTemplateId || undefined, assignNotes);
    setAssignSubmitting(false);
    if (!result.success) {
      setAssignError(humanizeBackendError(result.message, t) ?? t("assignError"));
      return;
    }
    setAssignNotes("");
    await loadSiteData();
  };

  const handleCancel = async (assignmentId: string) => {
    setCancellingId(assignmentId);
    const result = await ShiftRepository.cancel(assignmentId);
    setCancellingId(null);
    if (!result.success) {
      setAssignError(humanizeBackendError(result.message, t) ?? t("cancelError"));
      return;
    }
    await loadSiteData();
  };

  const myColumns: TableColumn<MyShiftRow>[] = [
    { key: "date", header: t("columns.date"), render: (row) => formatDateOnly(row.shiftDate, i18n.language) },
    { key: "site", header: t("columns.site"), render: (row) => row.siteName },
    { key: "time", header: t("columns.time"), render: (row) => `${row.startTime.slice(0, 5)} — ${row.endTime.slice(0, 5)}` },
    { key: "status", header: t("common:status"), render: (row) => <StatusBadge status={row.status === "scheduled" ? "active" : "revoked"}>{t(`status.${row.status}`)}</StatusBadge> },
    { key: "notes", header: t("columns.notes"), render: (row) => row.notes ?? "—" },
  ];

  const siteColumns: TableColumn<SiteShiftRow>[] = [
    { key: "employee", header: t("columns.employee"), render: (row) => row.employeeName },
    { key: "date", header: t("columns.date"), render: (row) => formatDateOnly(row.shiftDate, i18n.language) },
    { key: "time", header: t("columns.time"), render: (row) => `${row.startTime.slice(0, 5)} — ${row.endTime.slice(0, 5)}` },
    { key: "status", header: t("common:status"), render: (row) => <StatusBadge status={row.status === "scheduled" ? "active" : "revoked"}>{t(`status.${row.status}`)}</StatusBadge> },
    {
      key: "actions",
      header: t("common:actions.label"),
      render: (row) =>
        row.status === "scheduled" ? (
          <Button variant="ghost" size="sm" onClick={() => handleCancel(row.id)} loading={cancellingId === row.id}>
            {t("cancelAction")}
          </Button>
        ) : null,
    },
  ];

  return (
    <PageShell title={t("title")} subtitle={t("subtitle")}>
      <Card title={t("myShiftsTitle")}>
        <ErrorText>{loadError}</ErrorText>
        <Table columns={myColumns} data={myShifts} getRowId={(row) => row.id} loading={loading} emptyMessage={t("emptyMine")} />
      </Card>

      {canManage ? (
        <>
          <Card title={t("manageTitle")}>
            <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap", marginBottom: "var(--space-3)" }}>
              <Select label={t("siteLabel")} name="scheduleSite" value={selectedSiteId} onChange={(event) => setSelectedSiteId(event.target.value)} options={sites.map((site) => ({ value: site.id, label: site.name }))} />
              <Input label={t("rangeStartLabel")} name="scheduleRangeStart" type="date" value={rangeStart} onChange={(event) => setRangeStart(event.target.value)} />
              <Input label={t("rangeEndLabel")} name="scheduleRangeEnd" type="date" value={rangeEnd} onChange={(event) => setRangeEnd(event.target.value)} />
            </div>

            <Table columns={siteColumns} data={siteShifts} getRowId={(row) => row.id} loading={siteShiftsLoading} emptyMessage={t("emptySite")} />
          </Card>

          <Card title={t("templatesTitle")}>
            <p style={{ margin: "0 0 var(--space-2)", fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t("templatesHint")}</p>
            <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginBottom: "var(--space-3)" }}>
              {templates.map((template) => (
                <span
                  key={template.id}
                  style={{
                    padding: "var(--space-1) var(--space-3)",
                    borderRadius: "999px",
                    background: template.color ?? "var(--surface-hover)",
                    fontSize: "var(--font-xs)",
                    fontWeight: "var(--font-weight-medium)",
                  }}
                >
                  {template.name} ({template.startTime.slice(0, 5)}–{template.endTime.slice(0, 5)})
                </span>
              ))}
              {templates.length === 0 ? <span style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t("noTemplates")}</span> : null}
            </div>
            <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "flex-end", flexWrap: "wrap" }}>
              <Input label={t("templateNameLabel")} name="templateName" value={templateName} onChange={(event) => setTemplateName(event.target.value)} disabled={templateSubmitting} />
              <Input label={t("startTimeLabel")} name="templateStart" type="time" value={templateStart} onChange={(event) => setTemplateStart(event.target.value)} disabled={templateSubmitting} />
              <Input label={t("endTimeLabel")} name="templateEnd" type="time" value={templateEnd} onChange={(event) => setTemplateEnd(event.target.value)} disabled={templateSubmitting} />
              <Button onClick={handleCreateTemplate} loading={templateSubmitting} disabled={!templateName.trim() || !selectedSiteId}>
                {t("createTemplateAction")}
              </Button>
            </div>
            <ErrorText>{templateError}</ErrorText>
          </Card>

          <Card title={t("assignTitle")}>
            <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", alignItems: "flex-end" }}>
              <Select
                label={t("columns.employee")}
                name="assignUser"
                value={assignUserId}
                onChange={(event) => setAssignUserId(event.target.value)}
                disabled={assignSubmitting}
                options={[{ value: "", label: t("selectEmployeePlaceholder") }, ...members.map((member) => ({ value: member.id, label: member.fullName }))]}
              />
              {templates.length > 0 ? (
                <Select
                  label={t("templateLabel")}
                  name="assignTemplate"
                  value={assignTemplateId}
                  onChange={(event) => applyTemplate(event.target.value)}
                  disabled={assignSubmitting}
                  options={[{ value: "", label: t("customTimeOption") }, ...templates.map((template) => ({ value: template.id, label: template.name }))]}
                />
              ) : null}
              <Input label={t("columns.date")} name="assignDate" type="date" value={assignDate} onChange={(event) => setAssignDate(event.target.value)} disabled={assignSubmitting} />
              <Input label={t("startTimeLabel")} name="assignStart" type="time" value={assignStart} onChange={(event) => setAssignStart(event.target.value)} disabled={assignSubmitting} />
              <Input label={t("endTimeLabel")} name="assignEnd" type="time" value={assignEnd} onChange={(event) => setAssignEnd(event.target.value)} disabled={assignSubmitting} />
            </div>
            <Textarea label={t("notesLabel")} name="assignNotes" value={assignNotes} onChange={(event) => setAssignNotes(event.target.value)} disabled={assignSubmitting} rows={2} />
            <ErrorText>{assignError}</ErrorText>
            <Button onClick={handleAssign} loading={assignSubmitting} disabled={!assignUserId || !selectedSiteId || !assignDate}>
              {t("assignAction")}
            </Button>
          </Card>
        </>
      ) : null}
    </PageShell>
  );
}
