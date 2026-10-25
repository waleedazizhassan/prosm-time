import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";
import CalendarRepository, { type Holiday, type ScheduleException, type Weekday, type WorkCalendar } from "../../core/repositories/CalendarRepository";
import SiteRepository from "../../core/repositories/SiteRepository";
import EmployeeRepository from "../../core/repositories/EmployeeRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";
import { formatDateOnly } from "../../core/utils/formatDate";

import PageShell from "../../components/common/PageShell";
import PageBanner from "../../components/common/PageBanner";
import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Textarea from "../../components/common/Textarea";
import Toggle from "../../components/common/Toggle";
import Modal from "../../components/common/Modal";
import ListRow from "../../components/common/ListRow";
import EmptyState from "../../components/common/EmptyState";
import ErrorText from "../../components/common/ErrorText";
import HintText from "../../components/common/HintText";
import LoadingState from "../../components/common/LoadingState";
import calendarIllustration from "../../assets/illustrations/schedule.svg";

// Saturday first (the organisation's week starts on Saturday by default).
const WEEK: Weekday[] = [6, 0, 1, 2, 3, 4, 5];

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const emptyHoliday = { id: null as string | null, siteId: "", name: "", startDate: "", endDate: "", isPaid: true };
const emptyException = {
  id: null as string | null,
  scope: "organisation" as "organisation" | "site" | "person",
  siteId: "",
  userId: "",
  startDate: "",
  endDate: "",
  startTime: "",
  endTime: "",
  isDayOff: false,
  noDeduction: true,
  reason: "",
};

// v2.3.43 step 3 (items 7 and 8): "Calendar and holidays" - public holidays,
// weekly rest days (the organisation's and each site's) and exceptional
// days. Work on a rest day or a holiday counts as overtime; an exceptional
// day can change the hours and/or carry no deduction. Organisation-wide
// entries are the Owner's; a manager changes the sites they manage
// (calendar.manage, checked on the server).
export default function CalendarPage() {
  const { t, i18n } = useTranslation("calendar");
  const { hasPermission, profile } = useAuth();
  const isOwner = Boolean(profile?.isOwner);
  const canManage = hasPermission("calendar.manage");

  const [calendar, setCalendar] = useState<WorkCalendar | null>(null);
  const [managedSiteIds, setManagedSiteIds] = useState<Set<string> | null>(null);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [holiday, setHoliday] = useState<typeof emptyHoliday | null>(null);
  const [exception, setException] = useState<typeof emptyException | null>(null);

  const range = useMemo(() => {
    const from = new Date();
    from.setMonth(from.getMonth() - 1);
    const to = new Date();
    to.setMonth(to.getMonth() + 11);
    return { from: isoDate(from), to: isoDate(to) };
  }, []);

  const load = useCallback(async () => {
    const result = await CalendarRepository.getCalendar(range.from, range.to);
    if (!result.success || !result.data) {
      setLoadError(humanizeBackendError(result.message, t) ?? t("loadError"));
      return;
    }
    setCalendar(result.data);
  }, [range, t]);

  useEffect(() => {
    void load();
    if (!isOwner && profile?.id) {
      SiteRepository.listManagedSiteIds(profile.id).then((result) => setManagedSiteIds(new Set(result.data ?? [])));
    }
    EmployeeRepository.listOrganizationMembers().then((result) => {
      setPeople(
        (result.data ?? [])
          .filter((member) => !member.isOwner)
          .map((member) => ({ id: member.id, name: member.fullName }))
          .sort((a, b) => a.name.localeCompare(b.name, i18n.language)),
      );
    });
  }, [load, isOwner, profile?.id, i18n.language]);

  if (!canManage) return <Navigate to="/dashboard" replace />;

  const canEditSite = (siteId: string | null) => isOwner || (siteId !== null && (managedSiteIds?.has(siteId) ?? false));
  const editableSites = (calendar?.sites ?? []).filter((site) => canEditSite(site.id));
  const dayName = (day: Weekday) => t(`weekdays.${day}`);
  const daysLabel = (days: Weekday[] | null) => (days === null ? t("restDays.inherit") : days.length === 0 ? t("restDays.none") : WEEK.filter((d) => days.includes(d)).map(dayName).join("، "));
  const range2 = (start: string, end: string) => (start === end ? formatDateOnly(start, i18n.language) : `${formatDateOnly(start, i18n.language)} – ${formatDateOnly(end, i18n.language)}`);

  const run = async (action: () => Promise<{ success: boolean; message: string | null }>, after?: () => void) => {
    setBusy(true);
    setError("");
    const result = await action();
    setBusy(false);
    if (!result.success) {
      setError(humanizeBackendError(result.message, t) ?? t("genericError"));
      return;
    }
    after?.();
    await load();
  };

  const toggleRestDay = (siteId: string | null, current: Weekday[], day: Weekday) => {
    const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day];
    void run(() => CalendarRepository.setRestDays(siteId, null, next));
  };

  const saveHoliday = () => {
    if (!holiday) return;
    if (!holiday.name.trim() || !holiday.startDate) {
      setError(t("holidays.required"));
      return;
    }
    void run(
      () => CalendarRepository.saveHoliday({ id: holiday.id, siteId: holiday.siteId || null, name: holiday.name.trim(), startDate: holiday.startDate, endDate: holiday.endDate || holiday.startDate, isPaid: holiday.isPaid }),
      () => setHoliday(null),
    );
  };

  const saveException = () => {
    if (!exception) return;
    if (!exception.startDate || !exception.reason.trim()) {
      setError(t("exceptions.required"));
      return;
    }
    void run(
      () =>
        CalendarRepository.saveException({
          id: exception.id,
          siteId: exception.scope === "site" ? exception.siteId || null : null,
          shiftTemplateId: null,
          userId: exception.scope === "person" ? exception.userId || null : null,
          startDate: exception.startDate,
          endDate: exception.endDate || exception.startDate,
          startTime: exception.isDayOff ? null : exception.startTime || null,
          endTime: exception.isDayOff ? null : exception.endTime || null,
          isDayOff: exception.isDayOff,
          noDeduction: exception.noDeduction,
          reason: exception.reason.trim(),
        }),
      () => setException(null),
    );
  };

  const exceptionScope = (row: ScheduleException) =>
    row.userName ? row.userName : row.shiftTemplateName ? row.shiftTemplateName : row.siteName ? row.siteName : t("scope.organisation");
  const exceptionHours = (row: ScheduleException) =>
    row.isDayOff ? t("exceptions.dayOff") : [row.startTime ? t("exceptions.from", { time: row.startTime }) : null, row.endTime ? t("exceptions.to", { time: row.endTime }) : null].filter(Boolean).join(" ");

  return (
    <PageShell title="">
      <PageBanner pageId="calendar" illustration={calendarIllustration} />
      <ErrorText>{loadError || error}</ErrorText>
      {!calendar ? (
        loadError ? null : <LoadingState />
      ) : (
        <>
          <Card title={t("restDays.title")}>
            <HintText small>{t("restDays.hint")}</HintText>
            <div style={{ display: "grid", gap: "var(--space-2)" }}>
              <RestDaysRow
                label={t("scope.organisation")}
                days={calendar.restDays}
                editable={isOwner && !busy}
                dayName={dayName}
                onToggle={(day) => toggleRestDay(null, calendar.restDays, day)}
              />
              {calendar.sites.map((site) => (
                <div key={site.id}>
                  <RestDaysRow
                    label={site.name}
                    days={site.restDays ?? calendar.restDays}
                    inherited={site.restDays === null}
                    editable={canEditSite(site.id) && !busy}
                    dayName={dayName}
                    onToggle={(day) => toggleRestDay(site.id, site.restDays ?? calendar.restDays, day)}
                  />
                  {site.restDays !== null && canEditSite(site.id) ? (
                    <Button size="sm" variant="ghost" onClick={() => void run(() => CalendarRepository.setRestDays(site.id, null, null))} disabled={busy}>
                      {t("restDays.useOrganisation")}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
            <HintText small>{t("restDays.current", { days: daysLabel(calendar.restDays) })}</HintText>
          </Card>

          <Card
            title={t("holidays.title")}
            actions={
              <Button size="sm" onClick={() => { setError(""); setHoliday({ ...emptyHoliday, siteId: isOwner ? "" : editableSites[0]?.id ?? "" }); }}>
                {t("holidays.add")}
              </Button>
            }
          >
            <HintText small>{t("holidays.hint")}</HintText>
            {calendar.holidays.length === 0 ? (
              <EmptyState message={t("holidays.empty")} />
            ) : (
              calendar.holidays.map((row: Holiday) => (
                <ListRow key={row.id}>
                  <div>
                    <div style={{ fontSize: "var(--font-sm)", color: "var(--text-primary)", fontWeight: "var(--font-weight-semibold)" }}>{row.name}</div>
                    <div style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
                      {range2(row.startDate, row.endDate)} · {row.siteName ?? t("scope.organisation")} · {row.isPaid ? t("holidays.paid") : t("holidays.unpaid")}
                    </div>
                  </div>
                  {canEditSite(row.siteId) ? (
                    <div style={{ display: "flex", gap: "var(--space-1)" }}>
                      <Button size="sm" variant="ghost" onClick={() => { setError(""); setHoliday({ id: row.id, siteId: row.siteId ?? "", name: row.name, startDate: row.startDate, endDate: row.endDate, isPaid: row.isPaid }); }}>
                        {t("edit")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void run(() => CalendarRepository.deleteHoliday(row.id))} disabled={busy}>
                        {t("delete")}
                      </Button>
                    </div>
                  ) : null}
                </ListRow>
              ))
            )}
          </Card>

          <Card
            title={t("exceptions.title")}
            actions={
              <Button size="sm" onClick={() => { setError(""); setException({ ...emptyException, scope: isOwner ? "organisation" : "site", siteId: editableSites[0]?.id ?? "" }); }}>
                {t("exceptions.add")}
              </Button>
            }
          >
            <HintText small>{t("exceptions.hint")}</HintText>
            {calendar.exceptions.length === 0 ? (
              <EmptyState message={t("exceptions.empty")} />
            ) : (
              calendar.exceptions.map((row) => (
                <ListRow key={row.id}>
                  <div>
                    <div style={{ fontSize: "var(--font-sm)", color: "var(--text-primary)", fontWeight: "var(--font-weight-semibold)" }}>
                      {range2(row.startDate, row.endDate)} · {exceptionScope(row)}
                    </div>
                    <div style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
                      {[exceptionHours(row), row.noDeduction ? t("exceptions.noDeduction") : null, row.reason].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  {canEditSite(row.siteId) || (row.userId !== null && !isOwner) ? (
                    <Button size="sm" variant="ghost" onClick={() => void run(() => CalendarRepository.deleteException(row.id))} disabled={busy}>
                      {t("delete")}
                    </Button>
                  ) : null}
                </ListRow>
              ))
            )}
          </Card>
        </>
      )}

      <Modal
        isOpen={Boolean(holiday)}
        onClose={() => setHoliday(null)}
        title={holiday?.id ? t("holidays.editTitle") : t("holidays.add")}
        footer={
          <Button onClick={saveHoliday} loading={busy}>
            {t("save")}
          </Button>
        }
      >
        {holiday ? (
          <>
            <Input label={t("holidays.name")} name="holidayName" value={holiday.name} onChange={(event) => setHoliday({ ...holiday, name: event.target.value })} />
            <Input label={t("from")} name="holidayStart" type="date" value={holiday.startDate} onChange={(event) => setHoliday({ ...holiday, startDate: event.target.value })} />
            <Input label={t("to")} name="holidayEnd" type="date" value={holiday.endDate} onChange={(event) => setHoliday({ ...holiday, endDate: event.target.value })} />
            <Select
              label={t("scope.label")}
              name="holidaySite"
              value={holiday.siteId}
              onChange={(event) => setHoliday({ ...holiday, siteId: event.target.value })}
              options={[...(isOwner ? [{ value: "", label: t("scope.organisation") }] : []), ...editableSites.map((site) => ({ value: site.id, label: site.name }))]}
            />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "var(--space-2) 0" }}>
              <span style={{ fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>{t("holidays.paidLabel")}</span>
              <Toggle checked={holiday.isPaid} onChange={(checked) => setHoliday({ ...holiday, isPaid: checked })} label={t("holidays.paidLabel")} />
            </div>
            <ErrorText>{error}</ErrorText>
          </>
        ) : null}
      </Modal>

      <Modal
        isOpen={Boolean(exception)}
        onClose={() => setException(null)}
        title={t("exceptions.add")}
        footer={
          <Button onClick={saveException} loading={busy}>
            {t("save")}
          </Button>
        }
      >
        {exception ? (
          <>
            <Select
              label={t("scope.label")}
              name="exceptionScope"
              value={exception.scope}
              onChange={(event) => setException({ ...exception, scope: event.target.value as typeof exception.scope })}
              options={[
                ...(isOwner ? [{ value: "organisation", label: t("scope.organisation") }] : []),
                { value: "site", label: t("scope.site") },
                { value: "person", label: t("scope.person") },
              ]}
            />
            {exception.scope === "site" ? (
              <Select label={t("scope.site")} name="exceptionSite" value={exception.siteId} onChange={(event) => setException({ ...exception, siteId: event.target.value })} options={editableSites.map((site) => ({ value: site.id, label: site.name }))} />
            ) : null}
            {exception.scope === "person" ? (
              <Select
                label={t("scope.person")}
                name="exceptionPerson"
                value={exception.userId}
                onChange={(event) => setException({ ...exception, userId: event.target.value })}
                options={[{ value: "", label: "—" }, ...people.map((person) => ({ value: person.id, label: person.name }))]}
              />
            ) : null}
            <Input label={t("from")} name="exceptionStart" type="date" value={exception.startDate} onChange={(event) => setException({ ...exception, startDate: event.target.value })} />
            <Input label={t("to")} name="exceptionEnd" type="date" value={exception.endDate} onChange={(event) => setException({ ...exception, endDate: event.target.value })} />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "var(--space-2) 0" }}>
              <span style={{ fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>{t("exceptions.dayOffLabel")}</span>
              <Toggle checked={exception.isDayOff} onChange={(checked) => setException({ ...exception, isDayOff: checked })} label={t("exceptions.dayOffLabel")} />
            </div>
            {!exception.isDayOff ? (
              <>
                <Input label={t("exceptions.startTime")} name="exceptionStartTime" type="time" value={exception.startTime} onChange={(event) => setException({ ...exception, startTime: event.target.value })} />
                <Input label={t("exceptions.endTime")} name="exceptionEndTime" type="time" value={exception.endTime} onChange={(event) => setException({ ...exception, endTime: event.target.value })} />
              </>
            ) : null}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "var(--space-2) 0" }}>
              <span style={{ fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>{t("exceptions.noDeductionLabel")}</span>
              <Toggle checked={exception.noDeduction} onChange={(checked) => setException({ ...exception, noDeduction: checked })} label={t("exceptions.noDeductionLabel")} />
            </div>
            <Textarea label={t("exceptions.reason")} name="exceptionReason" value={exception.reason} onChange={(event) => setException({ ...exception, reason: event.target.value })} />
            <ErrorText>{error}</ErrorText>
          </>
        ) : null}
      </Modal>
    </PageShell>
  );
}

function RestDaysRow({
  label,
  days,
  inherited = false,
  editable,
  dayName,
  onToggle,
}: {
  label: string;
  days: Weekday[];
  inherited?: boolean;
  editable: boolean;
  dayName: (day: Weekday) => string;
  onToggle: (day: Weekday) => void;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--space-2)" }}>
      <span style={{ minWidth: "9rem", fontSize: "var(--font-sm)", color: "var(--text-primary)", fontWeight: "var(--font-weight-semibold)" }}>{label}</span>
      {WEEK.map((day) => {
        const on = days.includes(day);
        return (
          <button
            key={day}
            type="button"
            aria-pressed={on}
            disabled={!editable}
            onClick={() => onToggle(day)}
            style={{
              minHeight: "2.25rem",
              padding: "0 var(--space-3)",
              borderRadius: "var(--radius-full, 999px)",
              border: `1px solid ${on ? "var(--brand-primary)" : "var(--border-medium)"}`,
              background: on ? "var(--brand-primary)" : "transparent",
              color: on ? "var(--text-on-brand, #fff)" : "var(--text-primary)",
              opacity: inherited ? 0.7 : 1,
              fontSize: "var(--font-sm)",
              cursor: editable ? "pointer" : "default",
            }}
          >
            {dayName(day)}
          </button>
        );
      })}
    </div>
  );
}
