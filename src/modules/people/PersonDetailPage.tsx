import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useParams } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";
import EmployeeRepository, { type OrgMember } from "../../core/repositories/EmployeeRepository";
import PermissionRepository, { type Permission } from "../../core/repositories/PermissionRepository";
import DeviceBindingRepository, { type DeviceBinding } from "../../core/repositories/DeviceBindingRepository";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import Button from "../../components/common/Button";
import Modal from "../../components/common/Modal";
import Textarea from "../../components/common/Textarea";
import StatusBadge from "../../components/common/StatusBadge";
import AdminAttendanceCard from "./AdminAttendanceCard";

interface PendingChange {
  permission: Permission;
  action: "grant" | "revoke" | "reset";
}

const rowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "var(--space-3)",
  padding: "var(--space-3) 0",
  borderTop: "1px solid var(--border-light)",
};

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

  if (loading) {
    return (
      <PageShell title={t("detail.title")}>
        <p>…</p>
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
              <div key={permission.id} style={rowStyle}>
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
              </div>
            );
          })
        )}
      </Card>

      <Card title={t("detail.devicesTitle")}>
        <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-xs)", marginTop: 0 }}>{t("detail.devicesHint")}</p>
        {deviceActionError ? <p style={{ color: "var(--brand-danger)", fontSize: "var(--font-sm)" }}>{deviceActionError}</p> : null}
        {devices.length === 0 ? (
          <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>{t("detail.noDevices")}</p>
        ) : (
          devices.map((device) => (
            <div key={device.id} style={rowStyle}>
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
            </div>
          ))
        )}
      </Card>

      <AdminAttendanceCard subjectUserId={member.id} />

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
