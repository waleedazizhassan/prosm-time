import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

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

  const [members, setMembers] = useState<OrgMember[]>([]);
  const [userId, setUserId] = useState("");
  const [roleAtSite, setRoleAtSite] = useState<"member" | "manager">("member");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    setError("");
    setRoleAtSite("member");
    EmployeeRepository.listOrganizationMembers().then((result) => {
      const list = result.success ? result.data ?? [] : [];
      setMembers(list);
      setUserId(list[0]?.id ?? "");
    });
  }, [isOpen]);

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
        options={members.map((member) => ({ value: member.id, label: `${member.fullName} (${member.email})` }))}
      />
      <Select
        label={t("detail.assignForm.roleLabel")}
        name="assignSiteRole"
        value={roleAtSite}
        onChange={(event) => setRoleAtSite(event.target.value as "member" | "manager")}
        disabled={submitting}
        options={[
          { value: "member", label: t("detail.roleAtSite.member") },
          { value: "manager", label: t("detail.roleAtSite.manager") },
        ]}
      />

      {error ? <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{error}</p> : null}
    </Modal>
  );
}
