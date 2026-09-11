import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";
import EmployeeRepository, { type OrgMember } from "../../core/repositories/EmployeeRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import PageShell from "../../components/common/PageShell";
import Button from "../../components/common/Button";
import StatusBadge from "../../components/common/StatusBadge";
import Table, { type TableColumn } from "../../components/common/Table";
import InviteEmployeeModal from "./InviteEmployeeModal";
import ErrorText from "../../components/common/ErrorText";
import PageBanner from "../../components/common/PageBanner";
import peopleBanner from "../../assets/illustration-people-banner.png";

// PROSM Time Implementation Master File V3.0, WP-04/§37 - "Employee
// Management." Real org-member list (RLS-scoped) with an Invite action
// gated on the real 'employees.create' permission - hasPermission()
// only hides the button, the invite-user Edge Function itself
// re-checks this server-side (§9).
export default function PeoplePage() {
  const { t } = useTranslation("people");
  const navigate = useNavigate();
  const { hasPermission } = useAuth();

  const [members, setMembers] = useState<OrgMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    const result = await EmployeeRepository.listOrganizationMembers();
    if (!result.success) {
      setLoadError(humanizeBackendError(result.message, t) ?? t("loadError"));
      setMembers([]);
      setLoading(false);
      return;
    }
    setMembers(result.data ?? []);
    setLoading(false);
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  if (!hasPermission("employees.view")) {
    return <Navigate to="/dashboard" replace />;
  }

  const columns: TableColumn<OrgMember>[] = [
    {
      key: "name",
      header: t("columns.name"),
      render: (member) => (
        <>
          {member.fullName}
          {member.isOwner ? <StatusBadge status="active">{t("ownerBadge")}</StatusBadge> : null}
        </>
      ),
    },
    { key: "email", header: t("columns.email"), render: (member) => member.email },
    { key: "role", header: t("columns.role"), render: (member) => member.roleName },
    {
      key: "status",
      header: t("columns.status"),
      render: (member) =>
        member.isActive ? (
          <StatusBadge status={member.status}>{t(`status.${member.status}`, { defaultValue: member.status })}</StatusBadge>
        ) : (
          <StatusBadge status="deactivated">{t("detail.deactivatedBadge")}</StatusBadge>
        ),
    },
  ];

  return (
    <PageShell
      title={t("title")}
      subtitle={t("subtitle")}
      actions={hasPermission("employees.create") ? <Button onClick={() => setInviteOpen(true)}>{t("invite.actionLabel")}</Button> : undefined}
    >
      <PageBanner src={peopleBanner} />
      <ErrorText>{loadError}</ErrorText>

      <Table columns={columns} data={members} getRowId={(member) => member.id} loading={loading} emptyMessage="—" onRowClick={(member) => navigate(`/people/${member.id}`)} />

      <InviteEmployeeModal isOpen={inviteOpen} onClose={() => setInviteOpen(false)} onInvited={load} />
    </PageShell>
  );
}
