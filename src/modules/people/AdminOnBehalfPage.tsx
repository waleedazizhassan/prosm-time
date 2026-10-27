import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useSearchParams } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";
import EmployeeRepository, { type OrgMember } from "../../core/repositories/EmployeeRepository";
import { canActOnBehalfOf } from "../../core/utils/roleRank";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import Select from "../../components/common/Select";
import AdminAttendanceCard from "./AdminAttendanceCard";
import onBehalfHeaderImage from "../../assets/illustrations/adminClock.svg";
import PageBanner from "../../components/common/PageBanner";

// PROSM Time - § user-directed follow-up: Administrative Clock In/Out
// (On Behalf Of) already existed as a real, working card
// (AdminAttendanceCard) but was only reachable by first opening a
// specific employee's own People > detail page - no direct sidebar
// entry existed. This page is a thin picker in front of that exact
// same card (no new backend, no new capability): choose who, then the
// unchanged AdminAttendanceCard takes over - same authorization,
// same actor/subject/reason posture, same server-side re-checks.
export default function AdminOnBehalfPage() {
  const { t } = useTranslation("people");
  const { hasPermission, profile } = useAuth();
  const canUse = hasPermission("attendance.clock_in_on_behalf") || hasPermission("attendance.clock_out_on_behalf");

  const [members, setMembers] = useState<OrgMember[]>([]);
  const [loading, setLoading] = useState(true);
  // owner 2026-10-27: the dashboard's "didn't clock out" opens here with the person chosen
  const [searchParams] = useSearchParams();
  const [subjectId, setSubjectId] = useState(searchParams.get("user") ?? "");

  useEffect(() => {
    if (!canUse) return;
    EmployeeRepository.listOrganizationMembers().then((result) => {
      setMembers(result.success ? (result.data ?? []).filter((member) => member.isActive && profile !== null && canActOnBehalfOf(profile, member)) : []);
      setLoading(false);
    });
  }, [canUse, profile]);

  if (!canUse) {
    return <Navigate to="/dashboard" replace />;
  }

  const subject = members.find((member) => member.id === subjectId) ?? null;

  return (
    <PageShell title="">
      <PageBanner pageId="adminClock" illustration={onBehalfHeaderImage} />

      <Card title={t("onBehalf.pickEmployeeTitle")}>
        <Select
          label={t("onBehalf.employeeLabel")}
          name="onBehalfSubject"
          value={subjectId}
          onChange={(event) => setSubjectId(event.target.value)}
          disabled={loading}
          options={[{ value: "", label: t("onBehalf.employeePlaceholder") }, ...members.map((member) => ({ value: member.id, label: member.fullName }))]}
        />
      </Card>

      {subject ? <AdminAttendanceCard subjectUserId={subject.id} subjectFullName={subject.fullName} /> : null}
    </PageShell>
  );
}
