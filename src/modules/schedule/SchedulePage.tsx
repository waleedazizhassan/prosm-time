import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useAuth } from "../../core/context/AuthContext";
import ShiftRepository, { type MyShiftRow, type ShiftActual, type ShiftTemplate, type SiteShiftRow } from "../../core/repositories/ShiftRepository";
import SiteRepository, { type Site } from "../../core/repositories/SiteRepository";
import EmployeeRepository, { type OrgMember } from "../../core/repositories/EmployeeRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import { appLocale, formatDateOnly, formatTimeOnly } from "../../core/utils/formatDate";
import { isRtl } from "../../i18n/direction";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Textarea from "../../components/common/Textarea";
import Button from "../../components/common/Button";
import Table, { type TableColumn } from "../../components/common/Table";
import StatusBadge from "../../components/common/StatusBadge";
import ErrorText from "../../components/common/ErrorText";
import shiftsHeaderImage from "../../assets/illustrations/schedule.svg";
import PageBanner from "../../components/common/PageBanner";
import HintText from "../../components/common/HintText";
import Modal from "../../components/common/Modal";
import ScheduleRoster, { isoDay, weekDays } from "./ScheduleRoster";
import FieldRow from "../../components/common/FieldRow";
import BreakRulesModal from "./BreakRulesModal";
import ShiftSwapCard from "./ShiftSwapCard";
import ScheduleCostCard from "./ScheduleCostCard";
import OpenShiftsCard from "./OpenShiftsCard";
import ChecklistSettingsCard from "./ChecklistSettingsCard";
import usePlanFeatures from "../../core/hooks/usePlanFeatures";
import PlanLockedNote from "../../components/common/PlanLockedNote";

// the week starts on Sunday (as the dashboard's chart)
function startOfWeek(date: Date): string {
  return isoDay(new Date(date.getFullYear(), date.getMonth(), date.getDate() - date.getDay()));
}

function shiftWeek(start: string, days: number): string {
  const d = new Date(`${start}T00:00:00`);
  return isoDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days));
}

// end <= start means the shift crosses midnight and really ends the
// next day - shown as a "+1" suffix rather than a start time that
// silently looks later than the end time.
function formatShiftTime(startTime: string, endTime: string, crossesMidnight: boolean): string {
  const range = `${startTime.slice(0, 5)} — ${endTime.slice(0, 5)}`;
  return crossesMidnight ? `${range} (+1)` : range;
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
  const { allows } = usePlanFeatures(profile?.id);
  const scheduling = allows("scheduling");
  const canManage = hasPermission("schedules.manage") || Boolean(profile?.isOwner);

  const today = new Date();
  const [myShifts, setMyShifts] = useState<MyShiftRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [sites, setSites] = useState<Site[]>([]);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [templates, setTemplates] = useState<ShiftTemplate[]>([]);
  const [breakTemplate, setBreakTemplate] = useState<ShiftTemplate | null>(null);
  const [selectedSiteId, setSelectedSiteId] = useState("");
  const [siteShifts, setSiteShifts] = useState<SiteShiftRow[]>([]);
  const [actuals, setActuals] = useState<ShiftActual[]>([]);
  const [siteShiftsLoading, setSiteShiftsLoading] = useState(false);
  const [costKey, setCostKey] = useState(0);
  const [weekStart, setWeekStart] = useState(startOfWeek(today));
  const rangeStart = weekStart;
  const rangeEnd = shiftWeek(weekStart, 6);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignDays, setAssignDays] = useState<string[]>([]);
  const [openShift, setOpenShift] = useState<SiteShiftRow | null>(null);

  const [templateName, setTemplateName] = useState("");
  const [templateStart, setTemplateStart] = useState("08:00");
  const [templateEnd, setTemplateEnd] = useState("16:00");
  const [templateSubmitting, setTemplateSubmitting] = useState(false);
  const [templateError, setTemplateError] = useState("");

  const [assignUserId, setAssignUserId] = useState("");
  const [assignTemplateId, setAssignTemplateId] = useState("");
  const [assignStart, setAssignStart] = useState("08:00");
  const [assignEnd, setAssignEnd] = useState("16:00");
  const [assignNotes, setAssignNotes] = useState("");
  const [assignSubmitting, setAssignSubmitting] = useState(false);
  const [assignError, setAssignError] = useState("");
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const profileId = profile?.id;
  const loadMine = useCallback(async () => {
    if (!profileId) return;
    setLoading(true);
    setLoadError("");
    const result = await ShiftRepository.listMine(profileId);
    if (!result.success) setLoadError(humanizeBackendError(result.message, t) ?? t("loadError"));
    else setMyShifts(result.data ?? []);
    setLoading(false);
  }, [t, profileId]);

  useEffect(() => {
    loadMine();
  }, [loadMine]);

  useEffect(() => {
    if (!canManage || !profileId) return;
    // Only the sites the caller may schedule: every site for the Owner,
    // otherwise the sites they manage (the server allows no other).
    Promise.all([SiteRepository.listSites(), profile?.isOwner ? null : SiteRepository.listManagedSiteIds(profileId)]).then(([result, managed]) => {
      const all = result.success ? result.data ?? [] : [];
      const managedIds = managed && managed.success ? new Set(managed.data ?? []) : null;
      const list = profile?.isOwner ? all : all.filter((site) => managedIds?.has(site.id));
      setSites(list);
      setSelectedSiteId((current) => current || list[0]?.id || "");
    });
    EmployeeRepository.listOrganizationMembers().then((result) => {
      setMembers(result.success ? result.data ?? [] : []);
    });
  }, [canManage, profileId, profile?.isOwner]);

  const loadSiteData = useCallback(async () => {
    if (!canManage || !selectedSiteId) return;
    setSiteShiftsLoading(true);
    const [templatesResult, shiftsResult, actualRows] = await Promise.all([
      ShiftRepository.listTemplates(selectedSiteId),
      ShiftRepository.listForSite(selectedSiteId, rangeStart, rangeEnd),
      ShiftRepository.listActuals(selectedSiteId, rangeStart, rangeEnd),
    ]);
    setActuals(actualRows);
    setTemplates(templatesResult.success ? templatesResult.data ?? [] : []);
    setSiteShifts(shiftsResult.success ? shiftsResult.data ?? [] : []);
    setSiteShiftsLoading(false);
    setCostKey((current) => current + 1);
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

  const openAssign = (userId: string | null, day: string) => {
    setAssignUserId(userId ?? "");
    setAssignDays([day]);
    setAssignNotes("");
    setAssignError("");
    setAssignOpen(true);
  };

  // one shift per chosen day; stops at the first refusal and says which day
  const handleAssign = async () => {
    if (!assignUserId || !selectedSiteId || assignDays.length === 0) return;
    setAssignSubmitting(true);
    setAssignError("");
    for (const day of assignDays) {
      const result = await ShiftRepository.assign(assignUserId, selectedSiteId, day, `${assignStart}:00`, `${assignEnd}:00`, assignTemplateId || undefined, assignNotes);
      if (!result.success) {
        setAssignSubmitting(false);
        setAssignError(`${formatDateOnly(day, i18n.language)}: ${humanizeBackendError(result.message, t) ?? t("assignError")}`);
        setAssignDays((all) => all.filter((d) => d >= day));
        await loadSiteData();
        return;
      }
    }
    setAssignSubmitting(false);
    setAssignOpen(false);
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
    { key: "time", header: t("columns.time"), render: (row) => formatShiftTime(row.startTime, row.endTime, row.crossesMidnight) },
    { key: "status", header: t("common:status"), render: (row) => <StatusBadge status={row.status === "scheduled" ? "active" : "revoked"}>{t(`status.${row.status}`)}</StatusBadge> },
    { key: "notes", header: t("columns.notes"), render: (row) => row.notes ?? "—" },
  ];


  return (
    <PageShell title="">
      <PageBanner pageId="schedule" illustration={shiftsHeaderImage} />

      {/* The owner works no shifts: their own list is left out. */}
      {profile?.isRealOwner ? null : (
        <Card title={t("myShiftsTitle")}>
          <ErrorText>{loadError}</ErrorText>
          <Table columns={myColumns} data={myShifts} getRowId={(row) => row.id} loading={loading} emptyMessage={t("emptyMine")} />
        </Card>
      )}

      <OpenShiftsCard
        manageSiteId={canManage && scheduling && selectedSiteId ? selectedSiteId : null}
        onFilled={() => {
          void loadMine();
          void loadSiteData();
        }}
      />

      {scheduling ? (
      <ShiftSwapCard
        shifts={myShifts}
        onChanged={() => {
          void loadMine();
          void loadSiteData();
        }}
      />
      ) : null}

      {canManage && !scheduling ? (
        <Card title={t("manageTitle")}>
          <PlanLockedNote plan="business" />
        </Card>
      ) : null}

      {canManage && scheduling ? (
        <>
          <Card title={t("manageTitle")}>
            {/* owner 2026-11-09: the site and the week on one line, then the week as a roster */}
            <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap", alignItems: "flex-end", marginBottom: "var(--space-3)" }}>
              <div style={{ minWidth: 200 }}>
                <Select label={t("siteLabel")} name="scheduleSite" value={selectedSiteId} onChange={(event) => setSelectedSiteId(event.target.value)} options={sites.map((site) => ({ value: site.id, label: site.name }))} />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                <Button size="sm" variant="ghost" aria-label={t("roster.previous")} onClick={() => setWeekStart(shiftWeek(weekStart, -7))}>
                  {isRtl(i18n.language) ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
                </Button>
                <strong style={{ minWidth: "11rem", textAlign: "center", fontSize: "var(--font-sm)" }}>
                  {formatDateOnly(rangeStart, i18n.language)} – {formatDateOnly(rangeEnd, i18n.language)}
                </strong>
                <Button size="sm" variant="ghost" aria-label={t("roster.next")} onClick={() => setWeekStart(shiftWeek(weekStart, 7))}>
                  {isRtl(i18n.language) ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setWeekStart(startOfWeek(new Date()))}>{t("roster.thisWeek")}</Button>
              </div>
              <div style={{ marginInlineStart: "auto" }}>
                <Button onClick={() => openAssign(null, isoDay(new Date()) >= rangeStart && isoDay(new Date()) <= rangeEnd ? isoDay(new Date()) : rangeStart)} disabled={!selectedSiteId}>
                  <Plus size={16} /> {t("assignTitle")}
                </Button>
              </div>
            </div>
            <ErrorText>{assignError && !assignOpen ? assignError : ""}</ErrorText>
            <ScheduleRoster days={weekDays(weekStart)} shifts={siteShifts} actuals={actuals} templates={templates} loading={siteShiftsLoading}
              onAdd={(userId, day) => openAssign(userId, day)} onOpen={setOpenShift} />
            <HintText small>{t("roster.hint")}</HintText>
          </Card>

          {allows("labor_cost") ? <ScheduleCostCard siteId={selectedSiteId} startDate={rangeStart} endDate={rangeEnd} refreshKey={costKey} /> : null}
          {selectedSiteId ? <ChecklistSettingsCard siteId={selectedSiteId} /> : null}

          <Card title={t("templatesTitle")}>
            <HintText small>{t("templatesHint")}</HintText>
            <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginBottom: "var(--space-3)" }}>
              {templates.map((template) => (
                <button
                  type="button"
                  key={template.id}
                  title={t("breakRules.open")}
                  onClick={() => setBreakTemplate(template)}
                  style={{
                    border: "1px solid var(--border-light)",
                    cursor: "pointer",
                    color: "var(--text-primary)",
                    padding: "var(--space-1) var(--space-3)",
                    borderRadius: "999px",
                    background: template.color ?? "var(--surface-hover)",
                    fontSize: "var(--font-xs)",
                    fontWeight: "var(--font-weight-medium)",
                  }}
                >
                  {template.name} ({formatShiftTime(template.startTime, template.endTime, template.endTime <= template.startTime)})
                </button>
              ))}
              {templates.length === 0 ? <span style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>{t("noTemplates")}</span> : null}
            </div>
            <FieldRow style={{ gap: "var(--space-2)" }}>
              <Input label={t("templateNameLabel")} name="templateName" value={templateName} onChange={(event) => setTemplateName(event.target.value)} disabled={templateSubmitting} />
              <Input label={t("startTimeLabel")} name="templateStart" type="time" value={templateStart} onChange={(event) => setTemplateStart(event.target.value)} disabled={templateSubmitting} />
              <Input label={t("endTimeLabel")} name="templateEnd" type="time" value={templateEnd} onChange={(event) => setTemplateEnd(event.target.value)} disabled={templateSubmitting} />
              <Button onClick={handleCreateTemplate} loading={templateSubmitting} disabled={!templateName.trim() || !selectedSiteId}>
                {t("createTemplateAction")}
              </Button>
            </FieldRow>
            <ErrorText>{templateError}</ErrorText>
          </Card>

        </>
      ) : null}
      {/* owner 2026-11-09: a shift is added from the roster - one person, one or several days of the week */}
      <Modal isOpen={assignOpen} onClose={() => setAssignOpen(false)} title={t("assignTitle")}
        footer={<Button onClick={handleAssign} loading={assignSubmitting} disabled={!assignUserId || !selectedSiteId || assignDays.length === 0}>
          {assignDays.length > 1 ? t("roster.assignDays", { count: assignDays.length }) : t("assignAction")}
        </Button>}>
        <ErrorText>{assignError}</ErrorText>
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
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
              options={[{ value: "", label: t("customTimeOption") }, ...templates.map((template) => ({ value: template.id, label: `${template.name} (${formatShiftTime(template.startTime, template.endTime, template.endTime <= template.startTime)})` }))]}
            />
          ) : null}
          <FieldRow style={{ gap: "var(--space-2)" }}>
            <Input label={t("startTimeLabel")} name="assignStart" type="time" value={assignStart} onChange={(event) => setAssignStart(event.target.value)} disabled={assignSubmitting} />
            <Input label={t("endTimeLabel")} name="assignEnd" type="time" value={assignEnd} onChange={(event) => setAssignEnd(event.target.value)} disabled={assignSubmitting} />
          </FieldRow>
          <div>
            <span style={{ display: "block", fontSize: "var(--font-sm)", fontWeight: 600, marginBottom: "var(--space-1)" }}>{t("roster.days")}</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-1)" }}>
              {weekDays(weekStart).map((day) => {
                const on = assignDays.includes(day);
                const past = day < isoDay(new Date());
                return (
                  <button key={day} type="button" disabled={past || assignSubmitting} aria-pressed={on}
                    onClick={() => setAssignDays((all) => (on ? all.filter((d) => d !== day) : [...all, day].sort()))}
                    style={{ padding: "6px 10px", borderRadius: 999, border: `1px solid ${on ? "var(--brand-primary)" : "var(--border-light)"}`,
                      background: on ? "var(--brand-primary)" : "transparent", color: on ? "var(--text-on-brand, #fff)" : "var(--text-primary)",
                      opacity: past ? 0.4 : 1, cursor: past ? "default" : "pointer", font: "inherit", fontSize: "var(--font-xs)" }}>
                    {new Date(`${day}T00:00:00`).toLocaleDateString(appLocale(i18n.language), { weekday: "short", day: "numeric" })}
                  </button>
                );
              })}
            </div>
          </div>
          <Textarea label={t("notesLabel")} name="assignNotes" value={assignNotes} onChange={(event) => setAssignNotes(event.target.value)} disabled={assignSubmitting} rows={2} />
        </div>
      </Modal>

      <Modal isOpen={Boolean(openShift)} onClose={() => setOpenShift(null)} title={openShift ? openShift.employeeName : ""}
        footer={openShift ? (
          <Button variant="danger" onClick={async () => { await handleCancel(openShift.id); setOpenShift(null); }} loading={cancellingId === openShift.id}>
            {t("cancelAction")}
          </Button>
        ) : undefined}>
        {openShift ? (
          <div style={{ display: "grid", gap: "var(--space-2)", fontSize: "var(--font-sm)" }}>
            <span>{formatDateOnly(openShift.shiftDate, i18n.language)} · {formatShiftTime(openShift.startTime, openShift.endTime, openShift.crossesMidnight)}</span>
            {(() => {
              const actual = actuals.find((entry) => entry.assignmentId === openShift.id);
              return actual ? (
                <span>{t("columns.actual")}: {formatTimeOnly(actual.firstIn, i18n.language)} — {actual.lastOut ? formatTimeOnly(actual.lastOut, i18n.language) : "…"}</span>
              ) : null;
            })()}
            {openShift.notes ? <HintText small>{openShift.notes}</HintText> : null}
          </div>
        ) : null}
      </Modal>
      <BreakRulesModal template={breakTemplate} onClose={() => setBreakTemplate(null)} onSaved={() => void loadSiteData()} />
    </PageShell>
  );
}
