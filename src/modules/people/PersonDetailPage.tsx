import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useParams } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";
import EmployeeRepository, { type OrgMember } from "../../core/repositories/EmployeeRepository";
import PermissionRepository, { type Permission } from "../../core/repositories/PermissionRepository";
import DeviceBindingRepository, { type DeviceBinding } from "../../core/repositories/DeviceBindingRepository";
import KioskRepository from "../../core/repositories/KioskRepository";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import LoadingState from "../../components/common/LoadingState";
import EmptyState from "../../components/common/EmptyState";
import ListRow from "../../components/common/ListRow";
import Button from "../../components/common/Button";
import Input from "../../components/common/Input";
import Modal from "../../components/common/Modal";
import Textarea from "../../components/common/Textarea";
import StatusBadge from "../../components/common/StatusBadge";
import AdminAttendanceCard from "./AdminAttendanceCard";

interface PendingChange {
  permission: Permission;
  action: "grant" | "revoke" | "reset";
}

// PROSM Time Implementation Master File V3.0, WP-04/§9/§37 -
// "Administrator & Permission Management." Shows the real effective
// permission set (role bundle + overrides) and lets an authorized admin
// grant/revoke/reset individual permissions - every change is a real
// RPC call (set/clear_prosm_time_user_permission_override) that
// re-verifies the caller's own authority server-side; hasPermission()
// here only decides whether the controls render.
export default function PersonDetailPage() {
  const { t } = useTranslation("people");
  const { userId } = useParams<{ userId: string }>();
  const { hasPermission } = useAuth();

  const [member, setMember] = useState<OrgMember | null>(null);
  const [catalog, setCatalog] = useState<Permission[]>([]);
  const [effective, setEffective] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [devices, setDevices] = useState<DeviceBinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [pendingChange, setPendingChange] = useState<PendingChange | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [changeError, setChangeError] = useState("");

  const [deviceActionError, setDeviceActionError] = useState("");

  const [kioskPin, setKioskPin] = useState("");
  const [kioskPinSubmitting, setKioskPinSubmitting] = useState(false);
  const [kioskPinError, setKioskPinError] = useState("");
  const [kioskPinSuccess, setKioskPinSuccess] = useState(false);

  const [exportSubmitting, setExportSubmitting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const canManagePermissions = hasPermission("permissions.assign");
  const canManageDevices = hasPermission("employees.manage_accounts");

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setLoadError("");

    const [memberResult, catalogResult, effectiveResult, overridesResult, devicesResult] = await Promise.all([
      EmployeeRepository.getMember(userId),
      PermissionRepository.listCatalog(),
      PermissionRepository.getEffectivePermissions(userId),
      PermissionRepository.getUserOverrides(userId),
      DeviceBindingRepository.listForUser(userId),
    ]);

    if (!memberResult.success) {
      setLoadError(memberResult.message ?? t("detail.loadError"));
      setLoading(false);
      return;
    }

    setMember(memberResult.data);
    setCatalog(catalogResult.success ? catalogResult.data ?? [] : []);
    setEffective(effectiveResult.success ? effectiveResult.data ?? [] : []);
    setOverrides(overridesResult.success ? overridesResult.data ?? {} : {});
    setDevices(devicesResult.success ? devicesResult.data ?? [] : []);
    setLoading(false);
  }, [userId, t]);

  useEffect(() => {
    load();
  }, [load]);

  if (!hasPermission("employees.view")) {
    return <Navigate to="/dashboard" replace />;
  }

  const openChange = (permission: Permission, action: PendingChange["action"]) => {
    setChangeError("");
    setReason("");
    setPendingChange({ permission, action });
  };

  const handleConfirmChange = async () => {
    if (!pendingChange || !userId) return;
    if (!reason.trim()) {
      setChangeError(t("detail.reasonRequired"));
      return;
    }

    setSubmitting(true);
    setChangeError("");

    const result =
      pendingChange.action === "reset"
        ? await PermissionRepository.clearOverride(userId, pendingChange.permission.permissionKey, reason.trim())
        : await PermissionRepository.setOverride(userId, pendingChange.permission.permissionKey, pendingChange.action === "grant", reason.trim());

    setSubmitting(false);

    if (!result.success) {
      setChangeError(result.message ?? t("detail.genericError"));
      return;
    }

    setPendingChange(null);
    await load();
  };

  const handleDeviceStatus = async (deviceBindingId: string, status: "approved" | "blocked") => {
    setDeviceActionError("");
    const result = await DeviceBindingRepository.setStatus(deviceBindingId, status, `Set to ${status} from the Person detail screen.`);
    if (!result.success) {
      setDeviceActionError(result.message ?? "Unable to update this device.");
      return;
    }
    await load();
  };

  const handleSetKioskPin = async () => {
    if (!member) return;
    setKioskPinSubmitting(true);
    setKioskPinError("");
    setKioskPinSuccess(false);
    const result = await KioskRepository.adminSetPin(member.id, kioskPin);
    setKioskPinSubmitting(false);
    if (!result.success) {
      setKioskPinError(result.message ?? t("detail.kioskPinError"));
      return;
    }
    setKioskPin("");
    setKioskPinSuccess(true);
  };

  const handleExportData = async () => {
    if (!member) return;
    setExportSubmitting(true);
    setExportError("");
    const result = await EmployeeRepository.exportEmployeeData(member.id);
    setExportSubmitting(false);
    if (!result.success || !result.data) {
      setExportError(result.message ?? t("detail.exportError"));
      return;
    }
    const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: "application/json;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `employee-data-${member.fullName.replace(/\s+/g, "-")}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleDeleteData = async () => {
    if (!member || !deleteReason.trim()) return;
    setDeleteSubmitting(true);
    setDeleteError("");
    const result = await EmployeeRepository.deleteEmployeeData(member.id, deleteReason.trim());
    setDeleteSubmitting(false);
    if (!result.success) {
      setDeleteError(result.message ?? t("detail.deleteDataError"));
      return;
    }
    setDeleteModalOpen(false);
    setDeleteReason("");
    await load();
  };

  if (loading) {
    return (
      <PageShell title={t("detail.title")}>
        <LoadingState fullHeight />
      </PageShell>
    );
  }
  if (loadError || !member) {
    return (
      <PageShell title={t("detail.title")}>
        <p style={{ color: "var(--brand-danger)" }}>{loadError}</p>
      </PageShell>
    );
  }

  return (
    <PageShell title={member.fullName} subtitle={`${member.email} · ${member.roleName}`}>
      <Link to="/people" style={{ color: "var(--text-link)", fontSize: "var(--font-sm)" }}>
        {t("detail.backToList")}
      </Link>

      <Card title={t("detail.permissionsTitle")}>
        <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-xs)", marginTop: 0 }}>{t("detail.permissionsHint")}</p>

        {member.isOwner ? (
          <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>
            {t("ownerBadge")}: {catalog.length}/{catalog.length}
          </p>
        ) : (
          catalog.map((permission) => {
            const isGranted = effective.includes(permission.permissionKey);
            const isOverridden = permission.permissionKey in overrides;
            return (
              <ListRow key={permission.id}>
                <div>
                  <div style={{ fontWeight: isOverridden ? "var(--font-weight-bold)" : "var(--font-weight-regular)", color: "var(--text-primary)", fontSize: "var(--font-sm)" }}>
                    {permission.name}
                  </div>
                  <StatusBadge status={isGranted ? "active" : "neutral"}>{isGranted ? t("detail.grantedLabel") : t("detail.notGrantedLabel")}</StatusBadge>
                </div>
                {canManagePermissions ? (
                  <div style={{ display: "flex", gap: "var(--space-2)" }}>
                    {!isGranted ? (
                      <Button variant="ghost" size="xs" onClick={() => openChange(permission, "grant")}>
                        {t("detail.grantAction")}
                      </Button>
                    ) : (
                      <Button variant="ghost" size="xs" onClick={() => openChange(permission, "revoke")}>
                        {t("detail.revokeAction")}
                      </Button>
                    )}
                    {isOverridden ? (
                      <Button variant="ghost" size="xs" onClick={() => openChange(permission, "reset")}>
                        {t("detail.resetAction")}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </ListRow>
            );
          })
        )}
      </Card>

      <Card title={t("detail.devicesTitle")}>
        <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-xs)", marginTop: 0 }}>{t("detail.devicesHint")}</p>
        {deviceActionError ? <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{deviceActionError}</p> : null}
        {devices.length === 0 ? (
          <EmptyState message={t("detail.noDevices")} />
        ) : (
          devices.map((device) => (
            <ListRow key={device.id}>
              <div>
                <div style={{ color: "var(--text-primary)", fontSize: "var(--font-sm)" }}>{device.deviceLabel ?? device.deviceIdentifier}</div>
                <StatusBadge status={device.status}>{device.status}</StatusBadge>
              </div>
              <div style={{ display: "flex", gap: "var(--space-2)" }}>
                {canManageDevices && device.status !== "approved" ? (
                  <Button variant="ghost" size="xs" onClick={() => handleDeviceStatus(device.id, "approved")}>
                    {t("detail.approveAction")}
                  </Button>
                ) : null}
                {canManageDevices && device.status !== "blocked" ? (
                  <Button variant="ghost" size="xs" onClick={() => handleDeviceStatus(device.id, "blocked")}>
                    {t("detail.blockAction")}
                  </Button>
                ) : null}
              </div>
            </ListRow>
          ))
        )}
      </Card>

      {canManageDevices ? (
        <Card title={t("detail.kioskPinTitle")}>
          <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-xs)", marginTop: 0 }}>{t("detail.kioskPinHint")}</p>
          {kioskPinError ? <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{kioskPinError}</p> : null}
          {kioskPinSuccess ? <p style={{ color: "var(--status-success-text)", fontSize: "var(--font-sm)" }}>{t("detail.kioskPinSuccess")}</p> : null}
          <Input label={t("detail.kioskPinLabel")} name="kioskPin" type="password" value={kioskPin} onChange={(event) => setKioskPin(event.target.value.replace(/[^0-9]/g, "").slice(0, 6))} disabled={kioskPinSubmitting} />
          <Button onClick={handleSetKioskPin} loading={kioskPinSubmitting} disabled={kioskPin.length < 4}>
            {t("detail.kioskPinAction")}
          </Button>
        </Card>
      ) : null}

      {canManageDevices ? (
        <Card title={t("detail.dataRightsTitle")}>
          <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-xs)", marginTop: 0 }}>{t("detail.dataRightsHint")}</p>
          {exportError ? <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{exportError}</p> : null}
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Button variant="ghost" onClick={handleExportData} loading={exportSubmitting}>
              {t("detail.exportDataAction")}
            </Button>
            <Button variant="danger" onClick={() => setDeleteModalOpen(true)}>
              {t("detail.deleteDataAction")}
            </Button>
          </div>
        </Card>
      ) : null}

      <AdminAttendanceCard subjectUserId={member.id} />

      <Modal
        isOpen={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        title={t("detail.deleteDataAction")}
        footer={
          <Button variant="danger" onClick={handleDeleteData} loading={deleteSubmitting} disabled={!deleteReason.trim()}>
            {t("detail.confirmDeleteAction")}
          </Button>
        }
      >
        <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>{t("detail.deleteDataWarning")}</p>
        {deleteError ? <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{deleteError}</p> : null}
        <Textarea label={t("detail.deleteReasonLabel")} name="deleteReason" value={deleteReason} onChange={(event) => setDeleteReason(event.target.value)} disabled={deleteSubmitting} required />
      </Modal>

      <Modal
        isOpen={Boolean(pendingChange)}
        onClose={() => setPendingChange(null)}
        title={pendingChange ? pendingChange.permission.name : ""}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingChange(null)} disabled={submitting}>
              {t("common:actions.cancel")}
            </Button>
            <Button onClick={handleConfirmChange} loading={submitting}>
              {t("common:actions.confirm")}
            </Button>
          </>
        }
      >
        <Textarea label={t("detail.reasonLabel")} name="changeReason" value={reason} onChange={(event) => setReason(event.target.value)} required disabled={submitting} />
        {changeError ? <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{changeError}</p> : null}
      </Modal>
    </PageShell>
  );
}
