import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useParams } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";
import EmployeeRepository, { type OrgMember } from "../../core/repositories/EmployeeRepository";
import PermissionRepository, { type Permission } from "../../core/repositories/PermissionRepository";
import DeviceBindingRepository, { type DeviceBinding } from "../../core/repositories/DeviceBindingRepository";

import Button from "../../components/common/Button";
import Modal from "../../components/common/Modal";
import Textarea from "../../components/common/Textarea";

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

  if (loading) return <div style={{ padding: "2rem" }}>…</div>;
  if (loadError || !member) return <div style={{ padding: "2rem", color: "var(--danger)" }}>{loadError}</div>;

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "2rem 1rem" }}>
      <Link to="/people" style={{ color: "var(--accent-light)", fontSize: "0.85rem" }}>
        {t("backToDashboard")}
      </Link>
      <h1 style={{ fontSize: "1.5rem", marginTop: "0.5rem", marginBottom: 0 }}>{member.fullName}</h1>
      <p style={{ color: "var(--text-secondary)", marginTop: "0.25rem" }}>
        {member.email} · {member.roleName}
      </p>

      <section style={{ marginTop: "1.5rem" }}>
        <h2 style={{ fontSize: "1.1rem" }}>{t("detail.permissionsTitle")}</h2>
        <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>{t("detail.permissionsHint")}</p>

        {member.isOwner ? (
          <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>{t("ownerBadge")}: {catalog.length}/{catalog.length}</p>
        ) : (
          <div>
            {catalog.map((permission) => {
              const isGranted = effective.includes(permission.permissionKey);
              const isOverridden = permission.permissionKey in overrides;
              return (
                <div
                  key={permission.id}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.5rem 0", borderTop: "1px solid var(--border)" }}
                >
                  <div style={{ fontWeight: isOverridden ? 700 : 400 }}>
                    <div>{permission.name}</div>
                    <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                      {isGranted ? t("detail.grantedLabel") : t("detail.notGrantedLabel")}
                    </div>
                  </div>
                  {canManagePermissions ? (
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      {!isGranted ? (
                        <Button variant="ghost" onClick={() => openChange(permission, "grant")}>
                          {t("detail.grantAction")}
                        </Button>
                      ) : (
                        <Button variant="ghost" onClick={() => openChange(permission, "revoke")}>
                          {t("detail.revokeAction")}
                        </Button>
                      )}
                      {isOverridden ? (
                        <Button variant="ghost" onClick={() => openChange(permission, "reset")}>
                          {t("detail.resetAction")}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section style={{ marginTop: "1.5rem" }}>
        <h2 style={{ fontSize: "1.1rem" }}>{t("detail.devicesTitle")}</h2>
        <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>{t("detail.devicesHint")}</p>
        {deviceActionError ? <p style={{ color: "var(--danger)", fontSize: "0.85rem" }}>{deviceActionError}</p> : null}
        {devices.length === 0 ? (
          <p style={{ color: "var(--text-secondary)" }}>{t("detail.noDevices")}</p>
        ) : (
          devices.map((device) => (
            <div key={device.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.5rem 0", borderTop: "1px solid var(--border)" }}>
              <div>
                <div>{device.deviceLabel ?? device.deviceIdentifier}</div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>{device.status}</div>
              </div>
              {canManageDevices && device.status !== "approved" ? (
                <Button variant="ghost" onClick={() => handleDeviceStatus(device.id, "approved")}>
                  {t("detail.approveAction")}
                </Button>
              ) : null}
              {canManageDevices && device.status !== "blocked" ? (
                <Button variant="ghost" onClick={() => handleDeviceStatus(device.id, "blocked")}>
                  {t("detail.blockAction")}
                </Button>
              ) : null}
            </div>
          ))
        )}
      </section>

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
        {changeError ? <p style={{ color: "var(--danger)", fontSize: "0.85rem" }}>{changeError}</p> : null}
      </Modal>
    </div>
  );
}
