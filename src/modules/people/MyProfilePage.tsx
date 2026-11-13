import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";
import usePlanFeatures from "../../core/hooks/usePlanFeatures";
import EmployeeProfileRepository, { type EmployeeProfile } from "../../core/repositories/EmployeeProfileRepository";
import PageShell from "../../components/common/PageShell";
import LoadingState from "../../components/common/LoadingState";
import EmptyState from "../../components/common/EmptyState";
import Tabs, { type TabItem } from "../../components/common/Tabs";
import ProfileHeader from "./profile/ProfileHeader";
import PersonalDataTab from "./profile/PersonalDataTab";
import ContractsTab from "./profile/ContractsTab";
import { AttendanceTab, LeaveTab } from "./profile/ActivityTabs";
import { ProfileDocumentsTab, ProfilePenaltiesTab } from "./profile/LaterTabs";
import { MyLeavePanel } from "../leave/LeaveRequestsPage";
import AttendanceLogPage from "../attendance/AttendanceLogPage";
import TimesheetsPage from "../timesheets/TimesheetsPage";
import ExceptionsCard from "../dashboard/ExceptionsCard";
import Button from "../../components/common/Button";

type MyTab = "data" | "documents" | "penalties" | "contract" | "attendance" | "leave";

// HR suite feature 3 (2026-11-11): "My file" - the person's own file, read only: their data and
// contract, their documents (which they upload here), their warnings and incentives (acknowledge or
// appeal), their attendance and leave.
const ATTENDANCE_VIEWS = ["summary", "log", "timesheets", "exceptions"] as const;
type AttendanceView = (typeof ATTENDANCE_VIEWS)[number];

export default function MyProfilePage() {
  const { t } = useTranslation("people");
  const { profile } = useAuth();
  const { allows } = usePlanFeatures(profile?.id);
  const [file, setFile] = useState<EmployeeProfile | null>(null);
  const [failed, setFailed] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  const load = useCallback(async () => {
    if (!profile?.id) return;
    const result = await EmployeeProfileRepository.get(profile.id);
    setFailed(Boolean(result.error));
    setFile(result.data);
  }, [profile?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (failed) return <PageShell title={t("profile.myTitle")}><EmptyState message={t("profile.loadError")} /></PageShell>;
  if (!file || !profile) return <PageShell title={t("profile.myTitle")}><LoadingState fullHeight /></PageShell>;

  const tabs: TabItem<MyTab>[] = [
    // the same order as the user file (owner review 2026-11-12)
    { key: "data", label: t("profile.tabs.data") },
    { key: "contract", label: t("profile.tabs.contract") },
    ...(allows("documents") ? [{ key: "documents" as const, label: t("profile.tabs.documents") }] : []),
    { key: "attendance", label: t("profile.tabs.attendance") },
    { key: "leave", label: t("profile.tabs.leave") },
    ...(allows("penalties") ? [{ key: "penalties" as const, label: t("profile.tabs.penalties") }] : []),
  ];
  const requested = searchParams.get("tab") as MyTab | null;
  const tab: MyTab = requested && tabs.some((x) => x.key === requested) ? requested : "data";
  const requestedView = searchParams.get("view") as AttendanceView | null;
  const view: AttendanceView = requestedView && ATTENDANCE_VIEWS.includes(requestedView) ? requestedView : "summary";

  return (
    <PageShell title="">
      <ProfileHeader profile={file} onBuzz={false} />
      <Tabs items={tabs} active={tab} label={t("profile.tabsLabel")}
        onChange={(next) => setSearchParams((params) => { if (next === "data") params.delete("tab"); else params.set("tab", next); return params; }, { replace: true })} />
      {tab === "data" ? <PersonalDataTab profile={file} onSaved={() => void load()} /> : null}
      {tab === "documents" ? <ProfileDocumentsTab profile={file} onChanged={() => void load()} /> : null}
      {tab === "penalties" ? <ProfilePenaltiesTab profile={file} /> : null}
      {tab === "contract" ? <ContractsTab profile={file} onSaved={() => void load()} /> : null}
      {/* owner 2026-11-12: one place for one's own attendance - the summary, every record, the timesheets and the
          moments to explain (these were three pages of the menu) */}
      {tab === "attendance" ? (
        <>
          <div role="tablist" aria-label={t("profile.attendance.viewsLabel")} style={{ display: "grid", gridTemplateColumns: `repeat(${ATTENDANCE_VIEWS.length}, minmax(max-content, 1fr))`, gap: "var(--space-2)", margin: "0 0 var(--space-3)", overflowX: "auto", scrollbarWidth: "none", paddingBlock: 2 }}>
            {/* owner 2026-11-13: the four views on one line - "Exceptions" fell alone onto a second line; a narrow
                phone scrolls the line sideways instead */}
            {ATTENDANCE_VIEWS.map((v) => (
              <Button key={v} size="sm" role="tab" aria-selected={view === v} variant={view === v ? "primary" : "ghost"}
                onClick={() => setSearchParams((params) => { params.set("tab", "attendance"); if (v === "summary") params.delete("view"); else params.set("view", v); params.delete("exceptionId"); return params; }, { replace: true })}>
                {t(`profile.attendance.views.${v}`)}
              </Button>
            ))}
          </div>
          {view === "summary" ? <AttendanceTab userId={profile.id} /> : null}
          {view === "log" ? <AttendanceLogPage embedded selfUserId={profile.id} /> : null}
          {view === "timesheets" ? <TimesheetsPage embedded /> : null}
          {view === "exceptions" ? <ExceptionsCard showEmpty /> : null}
        </>
      ) : null}
      {/* owner 2026-11-12: one place for one's own leave - balance, request, permissions and requests */}
      {tab === "leave" ? (allows("leave") ? <MyLeavePanel /> : <LeaveTab userId={profile.id} />) : null}
    </PageShell>
  );
}
