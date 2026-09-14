import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";

import { useAuth } from "../../core/context/AuthContext";
import EmployeeRepository, { type OrgMember } from "../../core/repositories/EmployeeRepository";
import PermissionRepository, { type Permission } from "../../core/repositories/PermissionRepository";
import DeviceBindingRepository, { type DeviceBinding } from "../../core/repositories/DeviceBindingRepository";
import KioskRepository from "../../core/repositories/KioskRepository";
import LeaveRepository from "../../core/repositories/LeaveRepository";
import PayRateRepository, { type PayRate, type PayRateType } from "../../core/repositories/PayRateRepository";
import humanizeBackendError from "../../core/utils/humanizeBackendError";

import PageShell from "../../components/common/PageShell";
import Card from "../../components/common/Card";
import LoadingState from "../../components/common/LoadingState";
import EmptyState from "../../components/common/EmptyState";
import ListRow from "../../components/common/ListRow";
import Button from "../../components/common/Button";
import Input from "../../components/common/Input";
import Select from "../../components/common/Select";
import Modal from "../../components/common/Modal";
import Textarea from "../../components/common/Textarea";
import StatusBadge from "../../components/common/StatusBadge";
import ErrorText from "../../components/common/ErrorText";
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
  const { hasPermission, profile } = useAuth();
  const navigate = useNavigate();

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

  const [annualEntitlement, setAnnualEntitlement] = useState<number | null>(null);
  const [annualEntitlementInput, setAnnualEntitlementInput] = useState("");
  const [entitlementSubmitting, setEntitlementSubmitting] = useState(false);
  const [entitlementError, setEntitlementError] = useState("");
  const [entitlementSuccess, setEntitlementSuccess] = useState(false);

  const [currentPayRate, setCurrentPayRate] = useState<PayRate | null>(null);
  const [payRateTypeInput, setPayRateTypeInput] = useState<PayRateType>("MONTHLY");
  const [payRateAmountInput, setPayRateAmountInput] = useState("");
  const [payRateSubmitting, setPayRateSubmitting] = useState(false);
  const [payRateError, setPayRateError] = useState("");
  const [payRateSuccess, setPayRateSuccess] = useState(false);

  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const [deactivateModalOpen, setDeactivateModalOpen] = useState(false);
  const [deactivateReason, setDeactivateReason] = useState("");
  const [deactivateSubmitting, setDeactivateSubmitting] = useState(false);
  const [deactivateError, setDeactivateError] = useState("");
  const [reactivateSubmitting, setReactivateSubmitting] = useState(false);
  const [reactivateError, setReactivateError] = useState("");

  const [removeModalOpen, setRemoveModalOpen] = useState(false);
  const [removeReason, setRemoveReason] = useState("");
  const [removeSubmitting, setRemoveSubmitting] = useState(false);
  const [removeError, setRemoveError] = useState("");

  const canManagePermissions = hasPermission("permissions.assign");
  const canManageDevices = hasPermission("employees.manage_accounts");
  // § live UX review, user-directed - "requires a reason, and is
  // Owner-only authority" - deliberately not a permission flag like
  // every other action on this page, the user was explicit this one
  // is Owner-only.
  const canDeactivate = Boolean(profile?.isOwner);
  // § real request, user-directed - "an Owner button to override annual
  // entitlement" (real Egyptian labor-law context: 10+ years of
  // social-insurance tenure legally entitles 30 days/year, not the
  // org's 21-day default). Owner-only, same posture as canDeactivate.
  const canEditLeaveEntitlement = Boolean(profile?.isOwner);
  // § PROSM Finance labor-cost bridge (2026-09-14) - compensation data,
  // Owner-only both here and server-side (set_worker_pay_rate).
  const canEditPayRate = Boolean(profile?.isOwner);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setLoadError("");

    const [memberResult, catalogResult, effectiveResult, overridesResult, devicesResult, leaveBalanceResult, payRateResult] = await Promise.all([
      EmployeeRepository.getMember(userId),
      PermissionRepository.listCatalog(),
      PermissionRepository.getEffectivePermissions(userId),
      PermissionRepository.getUserOverrides(userId),
      DeviceBindingRepository.listForUser(userId),
      LeaveRepository.getBalanceFor(userId),
      PayRateRepository.getCurrentForUser(userId),
    ]);

    if (!memberResult.success) {
      setLoadError(humanizeBackendError(memberResult.message, t) ?? t("detail.loadError"));
      setLoading(false);
      return;
    }

    setMember(memberResult.data);
    setCatalog(catalogResult.success ? catalogResult.data ?? [] : []);
    setEffective(effectiveResult.success ? effectiveResult.data ?? [] : []);
    setOverrides(overridesResult.success ? overridesResult.data ?? {} : {});
    setDevices(devicesResult.success ? devicesResult.data ?? [] : []);
    if (leaveBalanceResult.success && leaveBalanceResult.data) {
      const annual = leaveBalanceResult.data.balances.find((entry) => entry.leaveType === "annual");
      setAnnualEntitlement(annual?.entitledDays ?? null);
      setAnnualEntitlementInput(annual?.entitledDays != null ? String(annual.entitledDays) : "");
    }
    if (payRateResult.success) {
      setCurrentPayRate(payRateResult.data);
      if (payRateResult.data) {
        setPayRateTypeInput(payRateResult.data.rateType);
        setPayRateAmountInput(String(payRateResult.data.rateAmount));
      }
    }
    setLoading(false);
  }, [userId, t]);

  const handleSetAnnualEntitlement = async () => {
    if (!userId) return;
    const days = Number(annualEntitlementInput);
    if (!Number.isFinite(days) || days < 0) return;
    setEntitlementSubmitting(true);
    setEntitlementError("");
    setEntitlementSuccess(false);
    const result = await LeaveRepository.setAnnualEntitlement(userId, new Date().getFullYear(), days);
    setEntitlementSubmitting(false);
    if (!result.success) {
      setEntitlementError(humanizeBackendError(result.message, t) ?? t("detail.leaveEntitlementError"));
      return;
    }
    setAnnualEntitlement(days);
    setEntitlementSuccess(true);
  };

  const handleSetPayRate = async () => {
    if (!userId) return;
    const amount = Number(payRateAmountInput);
    if (!Number.isFinite(amount) || amount <= 0) return;
    setPayRateSubmitting(true);
    setPayRateError("");
    setPayRateSuccess(false);
    const result = await PayRateRepository.setRateForUser(userId, payRateTypeInput, amount);
    setPayRateSubmitting(false);
    if (!result.success) {
      setPayRateError(humanizeBackendError(result.message, t) ?? t("detail.payRateError"));
      return;
    }
    setPayRateSuccess(true);
    await load();
  };

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
      setChangeError(humanizeBackendError(result.message, t) ?? t("detail.genericError"));
      return;
    }

    setPendingChange(null);
    await load();
  };

  const handleDeviceStatus = async (deviceBindingId: string, status: "approved" | "blocked") => {
    setDeviceActionError("");
    const result = await DeviceBindingRepository.setStatus(deviceBindingId, status, `Set to ${status} from the Person detail screen.`);
    if (!result.success) {
      setDeviceActionError(humanizeBackendError(result.message, t) ?? t("detail.genericError"));
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
      setKioskPinError(humanizeBackendError(result.message, t) ?? t("detail.kioskPinError"));
      return;
    }
    setKioskPin("");
    setKioskPinSuccess(true);
  };

  const handleDeactivate = async () => {
    if (!member || !deactivateReason.trim()) return;
    setDeactivateSubmitting(true);
    setDeactivateError("");
    const result = await EmployeeRepository.deactivateEmployee(member.id, deactivateReason.trim());
    setDeactivateSubmitting(false);
    if (!result.success) {
      setDeactivateError(humanizeBackendError(result.message, t) ?? t("detail.deactivateError"));
      return;
    }
    setDeactivateModalOpen(false);
    setDeactivateReason("");
    await load();
  };

  const handleReactivate = async () => {
    if (!member) return;
    setReactivateSubmitting(true);
    setReactivateError("");
    const result = await EmployeeRepository.reactivateEmployee(member.id);
    setReactivateSubmitting(false);
    if (!result.success) {
      setReactivateError(humanizeBackendError(result.message, t) ?? t("detail.reactivateError"));
      return;
    }
    await load();
  };

  const handleRemove = async () => {
    if (!member || !removeReason.trim()) return;
    setRemoveSubmitting(true);
    setRemoveError("");
    const result = await EmployeeRepository.removeEmployee(member.id, removeReason.trim());
    setRemoveSubmitting(false);
    if (!result.success) {
      setRemoveError(humanizeBackendError(result.message, t) ?? t("detail.removeError"));
      return;
    }
    // The employee's row no longer exists - nothing left to show here.
    navigate("/people", { replace: true });
  };

  const handleDeleteData = async () => {
    if (!member || !deleteReason.trim()) return;
    setDeleteSubmitting(true);
    setDeleteError("");
    const result = await EmployeeRepository.deleteEmployeeData(member.id, deleteReason.trim());
    setDeleteSubmitting(false);
    if (!result.success) {
      setDeleteError(humanizeBackendError(result.message, t) ?? t("detail.deleteDataError"));
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
        <ErrorText>{loadError}</ErrorText>
      </PageShell>
    );
  }

  return (
    <PageShell title={member.fullName} subtitle={`${member.email} · ${member.roleName}`}>
      <Link to="/people" style={{ color: "var(--text-link)", fontSize: "var(--font-sm)" }}>
        {t("detail.backToList")}
      </Link>

      {!member.isActive ? (
        <Card title={t("detail.accessTitle")}>
          <StatusBadge status="deactivated">{t("detail.deactivatedBadge")}</StatusBadge>
          <ErrorText>{reactivateError}</ErrorText>
          {canDeactivate ? (
            <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
              <Button onClick={handleReactivate} loading={reactivateSubmitting}>
                {t("detail.reactivateAction")}
              </Button>
            </div>
          ) : null}
        </Card>
      ) : canDeactivate && !member.isOwner ? (
        <Card title={t("detail.accessTitle")}>
          <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-xs)", marginTop: 0 }}>{t("detail.deactivateHint")}</p>
          <Button variant="danger" onClick={() => setDeactivateModalOpen(true)}>
            {t("detail.deactivateAction")}
          </Button>
        </Card>
      ) : null}

      {/* § live UX review, user-directed correction - "I asked for a
          button to remove an employee from the application, not just
          deactivate them." Permanent (users row + their real sign-in
          account both deleted) - available regardless of active/
          deactivated state, deliberately separate from the reversible
          deactivate action above. */}
      {canDeactivate && !member.isOwner ? (
        <Card title={t("detail.removeTitle")}>
          <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-xs)", marginTop: 0 }}>{t("detail.removeHint")}</p>
          <Button variant="danger" onClick={() => setRemoveModalOpen(true)}>
            {t("detail.removeAction")}
          </Button>
        </Card>
      ) : null}

      {canManagePermissions ? (
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
                      {t(`catalog.${permission.permissionKey}`, { defaultValue: permission.name })}
                    </div>
                    <StatusBadge status={isGranted ? "active" : "neutral"}>{isGranted ? t("detail.grantedLabel") : t("detail.notGrantedLabel")}</StatusBadge>
                  </div>
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
                </ListRow>
              );
            })
          )}
        </Card>
      ) : null}

      <Card title={t("detail.devicesTitle")}>
        <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-xs)", marginTop: 0 }}>{t("detail.devicesHint")}</p>
        <ErrorText>{deviceActionError}</ErrorText>
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
          <ErrorText>{kioskPinError}</ErrorText>
          {kioskPinSuccess ? <p style={{ color: "var(--status-success-text)", fontSize: "var(--font-sm)" }}>{t("detail.kioskPinSuccess")}</p> : null}
          <Input label={t("detail.kioskPinLabel")} name="kioskPin" type="password" value={kioskPin} onChange={(event) => setKioskPin(event.target.value.replace(/[^0-9]/g, "").slice(0, 6))} disabled={kioskPinSubmitting} />
          <Button onClick={handleSetKioskPin} loading={kioskPinSubmitting} disabled={kioskPin.length < 4}>
            {t("detail.kioskPinAction")}
          </Button>
        </Card>
      ) : null}

      {canEditLeaveEntitlement ? (
        <Card title={t("detail.leaveEntitlementTitle")}>
          <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-xs)", marginTop: 0 }}>{t("detail.leaveEntitlementHint")}</p>
          {annualEntitlement != null ? (
            <p style={{ fontSize: "var(--font-sm)", margin: "0 0 var(--space-2)" }}>{t("detail.leaveEntitlementCurrent", { days: annualEntitlement })}</p>
          ) : null}
          <ErrorText>{entitlementError}</ErrorText>
          {entitlementSuccess ? <p style={{ color: "var(--status-success-text)", fontSize: "var(--font-sm)" }}>{t("detail.leaveEntitlementSuccess")}</p> : null}
          <Input
            label={t("detail.leaveEntitlementLabel")}
            name="annualEntitlement"
            type="number"
            value={annualEntitlementInput}
            onChange={(event) => setAnnualEntitlementInput(event.target.value)}
            disabled={entitlementSubmitting}
          />
          <Button onClick={handleSetAnnualEntitlement} loading={entitlementSubmitting} disabled={!annualEntitlementInput.trim()}>
            {t("detail.leaveEntitlementAction")}
          </Button>
        </Card>
      ) : null}

      {canEditPayRate ? (
        <Card title={t("detail.payRateTitle")}>
          <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-xs)", marginTop: 0 }}>{t("detail.payRateHint")}</p>
          {currentPayRate ? (
            <p style={{ fontSize: "var(--font-sm)", margin: "0 0 var(--space-2)" }}>
              {t("detail.payRateCurrent", { amount: currentPayRate.rateAmount, currency: currentPayRate.currency, type: t(`detail.payRateType.${currentPayRate.rateType}`) })}
            </p>
          ) : null}
          <ErrorText>{payRateError}</ErrorText>
          {payRateSuccess ? <p style={{ color: "var(--status-success-text)", fontSize: "var(--font-sm)" }}>{t("detail.payRateSuccess")}</p> : null}
          <Select
            label={t("detail.payRateTypeLabel")}
            name="payRateType"
            value={payRateTypeInput}
            onChange={(event) => setPayRateTypeInput(event.target.value as PayRateType)}
            disabled={payRateSubmitting}
            options={[
              { value: "MONTHLY", label: t("detail.payRateType.MONTHLY") },
              { value: "HOURLY", label: t("detail.payRateType.HOURLY") },
            ]}
          />
          <Input label={t("detail.payRateAmountLabel")} name="payRateAmount" type="number" value={payRateAmountInput} onChange={(event) => setPayRateAmountInput(event.target.value)} disabled={payRateSubmitting} />
          <Button onClick={handleSetPayRate} loading={payRateSubmitting} disabled={!payRateAmountInput.trim()}>
            {t("detail.payRateAction")}
          </Button>
        </Card>
      ) : null}

      {canManageDevices ? (
        <Card title={t("detail.dataRightsTitle")}>
          <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-xs)", marginTop: 0 }}>{t("detail.dataRightsHint")}</p>
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Button variant="danger" onClick={() => setDeleteModalOpen(true)}>
              {t("detail.deleteDataAction")}
            </Button>
          </div>
        </Card>
      ) : null}

      <AdminAttendanceCard subjectUserId={member.id} subjectFullName={member.fullName} />

      <Modal
        isOpen={deactivateModalOpen}
        onClose={() => setDeactivateModalOpen(false)}
        title={t("detail.deactivateAction")}
        footer={
          <Button variant="danger" onClick={handleDeactivate} loading={deactivateSubmitting} disabled={!deactivateReason.trim()}>
            {t("detail.confirmDeactivateAction")}
          </Button>
        }
      >
        <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>{t("detail.deactivateWarning")}</p>
        <ErrorText>{deactivateError}</ErrorText>
        <Textarea label={t("detail.reasonLabel")} name="deactivateReason" value={deactivateReason} onChange={(event) => setDeactivateReason(event.target.value)} disabled={deactivateSubmitting} required />
      </Modal>

      <Modal
        isOpen={removeModalOpen}
        onClose={() => setRemoveModalOpen(false)}
        title={t("detail.removeAction")}
        footer={
          <Button variant="danger" onClick={handleRemove} loading={removeSubmitting} disabled={!removeReason.trim()}>
            {t("detail.confirmRemoveAction")}
          </Button>
        }
      >
        <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>{t("detail.removeWarning")}</p>
        <ErrorText>{removeError}</ErrorText>
        <Textarea label={t("detail.reasonLabel")} name="removeReason" value={removeReason} onChange={(event) => setRemoveReason(event.target.value)} disabled={removeSubmitting} required />
      </Modal>

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
        <ErrorText>{deleteError}</ErrorText>
        <Textarea label={t("detail.deleteReasonLabel")} name="deleteReason" value={deleteReason} onChange={(event) => setDeleteReason(event.target.value)} disabled={deleteSubmitting} required />
      </Modal>

      <Modal
        isOpen={Boolean(pendingChange)}
        onClose={() => setPendingChange(null)}
        title={pendingChange ? t(`catalog.${pendingChange.permission.permissionKey}`, { defaultValue: pendingChange.permission.name }) : ""}
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
        <ErrorText>{changeError}</ErrorText>
      </Modal>
    </PageShell>
  );
}
