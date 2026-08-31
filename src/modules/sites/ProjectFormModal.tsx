import { useState } from "react";
import { useTranslation } from "react-i18next";

import ProjectRepository, { type Project } from "../../core/repositories/ProjectRepository";

import Modal from "../../components/common/Modal";
import Input from "../../components/common/Input";
import Textarea from "../../components/common/Textarea";
import Button from "../../components/common/Button";
import Toggle from "../../components/common/Toggle";

interface ProjectFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
  siteId: string;
  project?: Project;
}

// PROSM Time WP-05/§14 - "Site -> Project -> Employee -> Assignment."
// Reused for create and edit - the parent mounts this with
// `key={project?.id ?? "create-project"}` so state resets cleanly.
export default function ProjectFormModal({ isOpen, onClose, onSaved, siteId, project }: ProjectFormModalProps) {
  const { t } = useTranslation("sites");
  const isEditing = Boolean(project);

  const [name, setName] = useState(project?.name ?? "");
  const [code, setCode] = useState(project?.code ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [isActive, setIsActive] = useState(project?.isActive ?? true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async () => {
    setSubmitting(true);
    setError("");

    const result =
      isEditing && project
        ? await ProjectRepository.updateProject(project.id, name.trim(), code.trim() || null, description.trim() || null, isActive)
        : await ProjectRepository.createProject(siteId, name.trim(), code.trim() || null, description.trim() || null);

    setSubmitting(false);

    if (!result.success) {
      setError(result.message ?? t("detail.projectForm.genericError"));
      return;
    }

    onSaved();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEditing ? t("detail.projectForm.editTitle") : t("detail.projectForm.createTitle")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {t("common:actions.cancel")}
          </Button>
          <Button onClick={handleSubmit} loading={submitting}>
            {t("detail.projectForm.confirm")}
          </Button>
        </>
      }
    >
      <Input label={t("detail.projectForm.nameLabel")} name="projectName" value={name} onChange={(event) => setName(event.target.value)} required disabled={submitting} />
      <Input label={t("detail.projectForm.codeLabel")} name="projectCode" value={code} onChange={(event) => setCode(event.target.value)} disabled={submitting} />
      <Textarea label={t("detail.projectForm.descriptionLabel")} name="projectDescription" value={description} onChange={(event) => setDescription(event.target.value)} disabled={submitting} />

      {isEditing ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "var(--space-2) 0" }}>
          <span style={{ fontSize: "var(--font-sm)", color: "var(--text-primary)" }}>{t("detail.projectForm.activeLabel")}</span>
          <Toggle checked={isActive} onChange={setIsActive} disabled={submitting} label={t("detail.projectForm.activeLabel")} />
        </div>
      ) : null}

      {error ? <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{error}</p> : null}
    </Modal>
  );
}
