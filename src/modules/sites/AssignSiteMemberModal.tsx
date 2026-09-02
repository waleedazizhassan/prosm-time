import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "../../core/context/AuthContext";
import EmployeeRepository, { type OrgMember } from "../../core/repositories/EmployeeRepository";
import SiteRepository from "../../core/repositories/SiteRepository";

import Modal from "../../components/common/Modal";
import Select from "../../components/common/Select";
import Button from "../../components/common/Button";

interface AssignSiteMemberModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAssigned: () => void;
  siteId: string;
}

// PROSM Time WP-05/§13 - "Assigned employees, assigned managers."
// set_prosm_time_site_assignment() upserts, so this also covers
// changing an existing assignment's role.
export default function AssignSiteMemberModal({ isOpen, onClose, onAssigned, siteId }: AssignSiteMemberModalProps) {
  const { t } = useTranslation("sites");
  const { profile } = useAuth();

  const [members, setMembers] = useState<OrgMember[]>([]);
  const [userId, setUserId] = useState("");
  const [roleAtSite, setRoleAtSite] = useState<"member" | "manager">("member");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // § live UX review, user-directed - confirmed real bug live: a
  // Manager (sites.manage, not Owner) could see the org's own Owner as
  // an assignable "member" here, and could grant the site-manager tier
  // to anyone including themselves. Fixed both here (UX) and, the
  // authoritative half, server-side in set_prosm_time_site_assignment
  // (§ migration 20260902070000) - a non-Owner caller may only add
  // role_key='employee' users, only ever as role_at_site='member'.
  const assignableMembers = useMemo(() => (profile?.isOwner ? members : members.filter((member) => !member.isOwner && member.roleKey === "employee")), [members, profile?.isOwner]);

  useEffect(() => {
    if (!isOpen) return;
    setError("");
    setRoleAtSite("member");
    EmployeeRepository.listOrganizationMembers().then((result) => {
      const list = result.success ? result.data ?? [] : [];
      setMembers(list);
    });
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    setUserId((current) => (assignableMembers.some((member) => member.id === current) ? current : assignableMembers[0]?.id ?? ""));
  }, [isOpen, assignableMembers]);

  const handleSubmit = async () => {
    if (!userId) return;
    setSubmitting(true);
    setError("");

    const result = await SiteRepository.setSiteAssignment(siteId, userId, roleAtSite);

    setSubmitting(false);

    if (!result.success) {
      setError(result.message ?? t("detail.assignForm.genericError"));
      return;
    }

    onAssigned();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t("detail.assignForm.title")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {t("common:actions.cancel")}
          </Button>
          <Button onClick={handleSubmit} loading={submitting} disabled={!userId}>
            {t("detail.assignForm.confirm")}
          </Button>
        </>
      }
    >
      <Select
        label={t("detail.assignForm.employeeLabel")}
        name="assignSiteMember"
        value={userId}
        onChange={(event) => setUserId(event.target.value)}
        disabled={submitting}
        options={assignableMembers.map((member) => ({ value: member.id, label: `${member.fullName} (${member.email})` }))}
      />
      <Select
        label={t("detail.assignForm.roleLabel")}
        name="assignSiteRole"
        value={roleAtSite}
        onChange={(event) => setRoleAtSite(event.target.value as "member" | "manager")}
        disabled={submitting || !profile?.isOwner}
        options={profile?.isOwner ? [
          { value: "member", label: t("detail.roleAtSite.member") },
          { value: "manager", label: t("detail.roleAtSite.manager") },
        ] : [
          { value: "member", label: t("detail.roleAtSite.member") },
        ]}
      />

      {error ? <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{error}</p> : null}
    </Modal>
  );
}
