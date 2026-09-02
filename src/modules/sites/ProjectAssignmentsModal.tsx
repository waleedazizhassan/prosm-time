import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import EmployeeRepository, { type OrgMember } from "../../core/repositories/EmployeeRepository";
import ProjectRepository, { type Project, type ProjectAssignment } from "../../core/repositories/ProjectRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import Modal from "../../components/common/Modal";
import Select from "../../components/common/Select";
import Button from "../../components/common/Button";
import EmptyState from "../../components/common/EmptyState";
import ListRow from "../../components/common/ListRow";
import ErrorText from "../../components/common/ErrorText";

interface ProjectAssignmentsModalProps {
  isOpen: boolean;
  onClose: () => void;
  project: Project;
}

// PROSM Time WP-05/§14 - "Employees must not be able to select
// projects to which they are not assigned." This is the admin UI for
// the authorization source (project_assignments) that rule reads from.
export default function ProjectAssignmentsModal({ isOpen, onClose, project }: ProjectAssignmentsModalProps) {
  const { t } = useTranslation("sites");

  const [members, setMembers] = useState<OrgMember[]>([]);
  const [assignments, setAssignments] = useState<ProjectAssignment[]>([]);
  const [pickerUserId, setPickerUserId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [membersResult, assignmentsResult] = await Promise.all([EmployeeRepository.listOrganizationMembers(), ProjectRepository.listProjectAssignments(project.id)]);
    setMembers(membersResult.success ? membersResult.data ?? [] : []);
    setAssignments(assignmentsResult.success ? assignmentsResult.data ?? [] : []);
  }, [project.id]);

  useEffect(() => {
    if (!isOpen) return;
    setError("");
    load();
  }, [isOpen, load]);

  const assignedUserIds = new Set(assignments.map((assignment) => assignment.userId));
  const unassignedMembers = members.filter((member) => !assignedUserIds.has(member.id));

  useEffect(() => {
    setPickerUserId(unassignedMembers[0]?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignments, members]);

  const handleAssign = async () => {
    if (!pickerUserId) return;
    setSubmitting(true);
    setError("");
    const result = await ProjectRepository.setProjectAssignment(project.id, pickerUserId);
    setSubmitting(false);
    if (!result.success) {
      setError(humanizeBackendError(result.message, t) ?? t("projectAssignments.genericError"));
      return;
    }
    load();
  };

  const handleRemove = async (userId: string) => {
    setSubmitting(true);
    setError("");
    const result = await ProjectRepository.removeProjectAssignment(project.id, userId);
    setSubmitting(false);
    if (!result.success) {
      setError(humanizeBackendError(result.message, t) ?? t("projectAssignments.genericError"));
      return;
    }
    load();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`${t("projectAssignments.title")} - ${project.name}`} footer={<Button onClick={onClose}>{t("projectAssignments.close")}</Button>}>
      <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-xs)", marginTop: 0 }}>{t("projectAssignments.hint")}</p>

      {unassignedMembers.length > 0 ? (
        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}>
            <Select
              label={t("detail.assignForm.employeeLabel")}
              name="projectAssignmentPicker"
              value={pickerUserId}
              onChange={(event) => setPickerUserId(event.target.value)}
              disabled={submitting}
              options={unassignedMembers.map((member) => ({ value: member.id, label: `${member.fullName} (${member.email})` }))}
            />
          </div>
          <Button variant="ghost" size="sm" onClick={handleAssign} disabled={submitting || !pickerUserId}>
            {t("projectAssignments.assignAction")}
          </Button>
        </div>
      ) : null}

      <ErrorText>{error}</ErrorText>

      {assignments.length === 0 ? (
        <EmptyState message={t("projectAssignments.noAssignments")} />
      ) : (
        assignments.map((assignment) => (
          <ListRow key={assignment.id}>
            <span style={{ color: "var(--text-primary)", fontSize: "var(--font-sm)" }}>{assignment.userFullName}</span>
            <Button variant="ghost" size="xs" onClick={() => handleRemove(assignment.userId)} disabled={submitting}>
              {t("projectAssignments.removeAssignmentAction")}
            </Button>
          </ListRow>
        ))
      )}
    </Modal>
  );
}
